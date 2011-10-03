/**
 * curl (cujo resource loader)
 *
 * (c) copyright 2011, unscriptable.com / John Hann
 * Licensed under the MIT License at:
 * 		http://www.opensource.org/licenses/mit-license.php
 *
 */

(function (global, doc, userCfg) {

	/*
	 * Overall operation:
	 * When a dependency is encountered and it already exists, it's returned.
	 * If it doesn't already exist, it is created and the dependency's script
	 * is loaded. If there is a define call in the loaded script with a name,
	 * it is resolved asap (i.e. as soon as the dependency's dependencies are
	 * resolved). If there is a (single) define call with no name (anonymous),
	 * the resource in the resNet is resolved after the script's onload fires.
	 * IE requires a slightly different tactic. IE marks the readyState of the
	 * currently executing script to 'interactive'. If we can find this script
	 * while a define() is being called, we can match the define() to its name.
	 * Opera marks scripts as 'interactive' but at inopportune times so we
	 * have to handle it specifically.
	 */

	/*
	 * Paths in 0.6:
	 * Use cases (most common first):
	 * -  "my package is located at this url" (url / location or package)
	 * -  "I want all text! plugins to use the module named x/text" (module id)
	 * -  "I want calls to 'x/a' from one package to reference 'x1.5/x/a' but
	 *    calls to 'x/a' from another package to reference 'x1.6/x/a'"
	 *    (url/location)
	 * -  "I want to alias calls to a generic 'array' module to the module
	 *     named 'y/array'" (module id) (or vice versa. see chat with JD Dalton)
	 * -  "I want to alias calls to 'my/array' to 'y/array'" (module id)
	 * -  "I want to use root paths like in node.js ("/x/b" should be the same
	 *    as "x/b" unless we implement a way to have each package specify its
	 *    relative dependency paths)
	 */

	var
		version = '0.5.3',
		head = doc['head'] || doc.getElementsByTagName('head')[0],
		// configuration information
		baseUrl,
		pluginPath = 'curl/plugin',
		paths = {},
		// local cache of resource definitions (lightweight promises)
		cache = {},
		// net to catch anonymous define calls' arguments (non-IE browsers)
		argsNet,
		// this is the list of scripts that IE is loading. one of these will
		// be the "interactive" script. too bad IE doesn't send a readystatechange
		// event to tell us exactly which one.
		activeScripts = {},
		// these are always handy :)
		toString = ({}).toString,
		undef,
		aslice = [].slice,
		// RegExp's used later, "cached" here
		absUrlRx = /^\/|^[^:]+:\/\//,
		normalizeRx = /^(\.)(\.)?(\/|$)/,
		findSlashRx = /\//,
		dontAddExtRx = /\?/,
		pathSearchRx,
		// script ready states that signify it's loaded
		readyStates = { 'loaded': 1, 'interactive': 1, 'complete': 1 },
		orsc = 'onreadystatechange',
		// the defaults for a typical package descriptor
		defaultDescriptor = {
			main: './lib/main',
			lib: './lib'
		},
		debug;

	function isType (obj, type) {
		return toString.call(obj).indexOf('[object ' + type) == 0;
	}

	function normalizePkgDescriptor (descriptor, nameOrIndex) {
		// TODO: remove nameOrIndex param
		// we need to use strings for prop names to account for google closure

		// check for string shortcuts
		if (isType(descriptor, 'String')) {
			descriptor = removeEndSlash(descriptor);
			// fill in defaults
			descriptor = {
				name: descriptor,
				'path': descriptor,
				'main': defaultDescriptor.main,
				'lib': defaultDescriptor.lib
			};
		}

		descriptor.path = descriptor['path'] || ''; // (isNaN(nameOrIndex) ? nameOrIndex : descriptor.name);

		function normalizePkgPart (partName) {
			var path;
			if (partName in descriptor) {
				if (descriptor[partName].charAt(0) != '.') {
					// prefix with path
					path = joinPath(descriptor.path, descriptor[partName]);
				}
				else {
					// use normal . and .. path processing
					path = normalizeName(descriptor[partName], descriptor.path);
				}
				return removeEndSlash(path);
			}
		}
		descriptor.lib = normalizePkgPart('lib');
		descriptor.main = normalizePkgPart('main');

		return descriptor;
	}

	function extractCfg (cfg) {
		var p, pStrip, path, pathList = [];

		baseUrl = cfg['baseUrl'] || '';

		if (cfg['debug']) {
			debug = true;
			// add debugging aides
			_curl['cache'] = cache;
			_curl['cfg'] = cfg;
			_curl['undefine'] = function (moduleId) { delete cache[moduleId]; };
		}

		// fix all paths
		var cfgPaths = cfg['paths'];
		for (p in cfgPaths) {
			pStrip = removeEndSlash(p.replace('!', '!/'));
			path = paths[pStrip] = { path: removeEndSlash(cfgPaths[p]) };
			path.specificity = (path.path.match(findSlashRx) || []).length;
			pathList.push(pStrip);
		}

		var cfgPackages = cfg['packages'];
		for (p in cfgPackages) {
			pStrip = removeEndSlash(cfgPackages[p]['name'] || p);
			path = paths[pStrip] = normalizePkgDescriptor(cfgPackages[p], pStrip);
			path.specificity = (path.path.match(findSlashRx) || []).length;
			pathList.push(pStrip);
		}

		// create path matcher
		pathSearchRx = new RegExp('^(' +
			pathList.sort(function (a, b) { return paths[a].specificity < paths[b].specificity; } )
				.join('|')
				.replace(/\//g, '\\/') +
			')(?=\\/|$)'
		);

		pluginPath = cfg['pluginPath'] || pluginPath;

	}

	function noop () {}

	function begetCtx (name) {

		function toUrl (n) {
			return resolveUrl(resolvePath(normalizeName(n, baseName)), baseUrl);
		}

		var baseName = name.substr(0, name.lastIndexOf('/')),
			ctx = {
				baseName: baseName
			},
			exports = {},
			require = function (deps, callback) {
				return _require(deps, callback || noop, ctx);
			};
		// CommonJS Modules 1.1.1 compliance
		ctx.vars = {
			'exports': exports,
			'module': {
				'id': normalizeName(name, baseName),
				'uri': toUrl(name),
				'exports': exports
			}
		};
		if (debug) {
			require['curl'] = _curl;
		}
		ctx.require = ctx.vars['require'] = require;
		// using bracket property notation so closure won't clobber name
		require['toUrl'] = toUrl;

		return ctx;
	}

	function Begetter () {}

	function beget (parent) {
		Begetter.prototype = parent;
		var child = new Begetter();
		Begetter.prototype = undef;
		return child;
	}

	function begetCfg (absPluginId) {
		var root;
		root = absPluginId ?
			userCfg['plugins'] && userCfg['plugins'][absPluginId] :
			userCfg;
		return beget(root);
	}

	function Promise () {

		var self = this,
			thens = [];

		function then (resolved, rejected) {
			// capture calls to callbacks
			thens.push([resolved, rejected]);
		}

		function resolve (val) { complete(true, val); }

		function reject (ex) { complete(false, ex); }

		function complete (success, arg) {
			// switch over to sync then()
			then = success ?
				function (resolve, reject) { resolve && resolve(arg); } :
				function (resolve, reject) { reject && reject(arg); };
			// disallow multiple calls to resolve or reject
			resolve = reject =
				function () { throw new Error('Promise already completed.'); };
			// complete all callbacks
			var aThen, cb, i = 0;
			while ((aThen = thens[i++])) {
				cb = aThen[success ? 0 : 1];
				if (cb) cb(arg);
			}
		}

		this.then = function (resolved, rejected) {
			then(resolved, rejected);
			return self;
		};
		this.resolve = function (val) {
			self.resolved = val;
			resolve(val);
		};
		this.reject = function (ex) {
			self.rejected = ex;
			reject(ex);
		};

	}

	function ResourceDef (name) {
		Promise.apply(this);
		this.name = name;
	}

	function endsWithSlash (str) {
		return str.charAt(str.length - 1) == '/';
	}

	function joinPath (path, file) {
		return (!path || endsWithSlash(path) ? path : path + '/') + file;
	}

	function removeEndSlash (path) {
		return endsWithSlash(path) ? path.substr(0, path.length - 1) : path;
	}

	function resolvePath (name, prefix) {
		// TODO: figure out why this gets called so often for the same file
		// searches through the configured path mappings and packages
		// if the resulting module is part of a package, also return the main
		// module so it can be loaded.
		var pathInfo, path, found;

		function fixPath (name) {
			path = name.replace(pathSearchRx, function (match) {

				pathInfo = paths[match] || {};
				found = true;

				// if pathInfo.main and match == name, this is a main module
				if (pathInfo.main && match == name) {
					return pathInfo.main;
				}
				// if pathInfo.lib return pathInfo.lib
				else if (pathInfo.lib) {
					return pathInfo.lib;
				}
				else {
					return pathInfo.path || '';
				}

			});
		}

		// if this is a plugin-specific path to resolve
		if (prefix) {
			fixPath(prefix + '!/' + name);
		}
		if (!found) {
			fixPath(name);
		}

		return path;
	}

	function resolveUrl(path, baseUrl, addExt) {
		return (baseUrl && !absUrlRx.test(path) ? joinPath(baseUrl, path) : path) + (addExt && !dontAddExtRx.test(path) ? '.js' : '');
	}

	function loadScript (def, success, failure) {
		// script processing rules learned from RequireJS

		// insert script
		var el = doc.createElement('script');

		// initial script processing
		function process (ev) {
			ev = ev || global.event;
			// detect when it's done loading
			if (ev.type === 'load' || readyStates[this.readyState]) {
				delete activeScripts[def.name];
				// release event listeners
				this.onload = this[orsc] = this.onerror = null;
				success(el);
			}
		}

		function fail (e) {
			// some browsers send an event, others send a string,
			// but none of them send anything useful, so just say we failed:
			failure(new Error('Syntax error or http error: ' + def.url));
		}

		// set type first since setting other properties could
		// prevent us from setting this later
		el.type = 'text/javascript';
		// using dom0 event handlers instead of wordy w3c/ms
		el.onload = el[orsc] = process;
		el.onerror = fail;
		el.charset = def.charset || 'utf-8';
		el.async = true;
		el.src = def.url;

		// loading will start when the script is inserted into the dom.
		// IE will load the script sync if it's in the cache, so
		// indicate the current resource definition if this happens.
		activeScripts[def.name] = el;
		// use insertBefore to keep IE from throwing Operation Aborted (thx Bryan Forbes!)
		head.insertBefore(el, head.firstChild);

	}

	function fixArgs (args) {
		// resolve args
		// valid combinations for define:
		// (string, array, object|function) sax|saf
		// (array, object|function) ax|af
		// (string, object|function) sx|sf
		// (object|function) x|f

		var name, deps, definition, isDefFunc, len = args.length;

		definition = args[len - 1];
		isDefFunc = isType(definition, 'Function');

		if (len == 2) {
			if (isType(args[0], 'Array')) {
				deps = args[0];
			}
			else {
				name = args[0];
			}
		}
		else if (len == 3) {
			name = args[0];
			deps = args[1];
		}

		// mimic RequireJS's assumption that a definition function with zero
		// dependencies and non-zero arity is a wrapped CommonJS module
		if (!deps && isDefFunc && definition.length > 0) {
			deps = ['require', 'exports', 'module'];
		}

		return {
			name: name,
			deps: deps || [],
			res: isDefFunc ? definition : function () { return definition; }
		};
	}

	function resolveResDef (def, args, ctx) {

		if (debug && console) {
			console.log('curl: resolving', def.name);
		}

		// if a module id has been remapped, it will have a baseName
		var childCtx = begetCtx(def.baseName || def.name);

		// get the dependencies and then resolve/reject
		getDeps(def, args.deps, childCtx,
			function (deps) {
				try {
					// node.js assumes `this` === exports
					// anything returned overrides exports
					var res = args.res.apply(childCtx.vars['exports'], deps) || childCtx.vars['exports'];
					if (debug && console) {
						console.log('curl: defined', def.name, res.toString().substr(0, 50).replace(/\n/, ' '));
					}
				}
				catch (ex) {
					def.reject(ex);
				}
				def.resolve(res);
			},
			def.reject
		);

	}

	function fetchResDef (def, ctx) {

		loadScript(def,

			function () {
				var args = argsNet;
				argsNet = undef; // reset it before we get deps

				// if our resource was not explicitly defined with a name (anonymous)
				// Note: if it did have a name, it will be resolved in the define()
				if (def.useNet !== false) {

					if (!args) {
						// uh oh, nothing was added to the resource net
						def.reject(new Error('define() not found or duplicates found: ' + def.url));
					}
					else if (args.ex) {
						// the resNet resource was already rejected, but it didn't know
						// its name, so reject this def now with better information
						def.reject(new Error(args.ex.replace('${url}', def.url)));
					}
					else {
						resolveResDef(def, args, ctx);
					}
				}

			},

			def.reject

		);

		return def;

	}

	function normalizeName (name, baseName) {
		// if name starts with . then use parent's name as a base
		// if name starts with .. then use parent's parent
		return name.replace(normalizeRx, function (match, dot1, dot2) {
			return (dot2 ? baseName.substr(0, baseName.lastIndexOf('/')) : baseName) + '/';
		});
	}

	function fetchDep (depName, ctx) {
		var name, delPos, prefix, resName, def, cfg;

		// check for plugin prefix
		delPos = depName.indexOf('!');
		if (delPos >= 0) {

			prefix = depName.substr(0, delPos);
			resName = depName.substr(delPos + 1);

			// prepend plugin folder path, if it's missing and path isn't in paths
			var prefixPath = resolvePath(prefix);
			var slashPos = prefixPath.indexOf('/');
			if (slashPos < 0) {
				prefixPath = resolvePath(joinPath(pluginPath, prefixPath));
			}

			// fetch plugin
			var pluginDef = cache[prefix];
			if (!pluginDef) {
				pluginDef = cache[prefix] = new ResourceDef(prefix);
				pluginDef.url = resolveUrl(prefixPath, baseUrl, true);
				pluginDef.baseName = prefixPath;
				fetchResDef(pluginDef, ctx);
			}

			// alter the toUrl passed into the plugin so that it can
			// also find plugin-prefixed path specifiers. e.g.:
			// "js!resourceId": "path/to/js/resource"
			// TODO: make this more efficient by allowing toUrl to be
			// overridden more easily and detecting if there's a
			// plugin-specific path more efficiently
			ctx = begetCtx(ctx.baseName);
			ctx.require['toUrl'] = function toUrl (absId) {
				var prefixed, path;
				path = resolvePath(absId, prefix);
				return resolveUrl(path, baseUrl);
			};

			// get plugin config
			cfg = begetCfg(prefix) || {};

			function toAbsId (id) {
				return normalizeName(id, ctx.baseName);
			}

			// we need to use depName until plugin tells us normalized name
			// if the plugin may changes the name, we need to consolidate
			// def promises below
			def = new ResourceDef(depName);

			pluginDef.then(
				function (plugin) {
					var normalizedDef;

					resName = depName.substr(delPos + 1);
					// check if plugin supports the normalize method
					if ('normalize' in plugin) {
						resName = plugin['normalize'](resName, toAbsId, cfg);
					}
					else {
						resName = toAbsId(resName);
					}

					// the spec is unclear, so we're using the full name (prefix + name) to id resources
					// so multiple plugins could each process the same resource
					name = prefix + '!' + resName;
					normalizedDef = cache[name];

					// if this is our first time fetching this (normalized) def
					if (!normalizedDef) {

						normalizedDef = new ResourceDef(name);

						// resName could be blank if the plugin doesn't specify a name (e.g. "domReady!")
						// don't cache non-determinate "dynamic" resources (or non-existent resources)
						if (resName && !plugin['dynamic']) {
							cache[name] = normalizedDef;
						}

						// curl's plugins prefer to receive the back-side of a promise,
						// but to be compatible with commonjs's specification, we have to
						// piggy-back on the callback function parameter:
						var loaded = normalizedDef.resolve;
						// using bracket property notation so closure won't clobber name
						loaded['resolve'] = loaded;
						loaded['reject'] = normalizedDef.reject;

						// load the resource!
						plugin.load(resName, ctx.require, loaded, cfg);

					}

					// chain defs (resolve when plugin.load executes)
					normalizedDef.then(def.resolve, def.reject);

				},
				def.reject
			);

		}
		else {
			resName = name = normalizeName(depName, ctx.baseName);

			def = cache[resName];
			if (!def) {
				def = cache[resName] = new ResourceDef(resName);
				def.url = resolveUrl(resolvePath(resName), baseUrl, true);
				fetchResDef(def, ctx);
			}

		}

		return def;
	}

	function getDeps (def, names, ctx, success, failure) {

		var deps = [],
			count = names.length,
			len = count,
			completed = false;

		// obtain each dependency
		// Note: IE may have obtained the dependencies sync (stooooopid!) thus the completed flag
		for (var i = 0; i < len && !completed; i++) (function (index, depName) {
			if (depName in ctx.vars) {
				deps[index] = ctx.vars[depName];
				count--;
			}
			else {
				// hook into promise callbacks
				fetchDep(depName, ctx).then(
					function (dep) {
						deps[index] = dep; // got it!
						if (--count == 0) {
							completed = true;
							success(deps);
						}
					},
					function (ex) {
						completed = true;
						failure(ex);
					}
				);
			}
		}(i, names[i]));

		// were there none to fetch and did we not already complete the promise?
		if (count == 0 && !completed) {
			success(deps);
		}

	}

	function getCurrentDefName () {
		// Note: Opera lies about which scripts are "interactive", so we
		// just have to test for it. Opera provides a true browser test, not
		// a UA sniff thankfully.
		// TODO: find a way to remove this browser test
		var def;
		if (!isType(global.opera, 'Opera')) {
			for (var d in activeScripts) {
				if (activeScripts[d].readyState == 'interactive') {
					def = d;
					break;
				}
			}
		}
		return def;
	}

	function _require (deps, callback, ctx) {
		// Note: callback could be a promise

		// RValue require
		if (isType(deps, 'String')) {
			// return resource
			var def = cache[deps],
				res = def && def.resolved;
			if (res === undef) {
				throw new Error('Module is not already resolved: '  + deps);
			}
			return res;
		}

		// resolve dependencies
		getDeps(null, deps, ctx,
			function (deps) {
				// Note: deps are passed to a promise as an array, not as individual arguments
				callback.resolve ? callback.resolve(deps) : callback.apply(null, deps);
			},
			function (ex) {
				if (callback.reject) callback.reject(ex);
				else throw ex;
			}
		);

	}

	function _curl (/* various */) {

		var args = aslice.call(arguments), callback, names, ctx;

		// extract config, if it's specified
		if (isType(args[0], 'Object')) {
			userCfg = args.shift();
			extractCfg(userCfg);
		}

		// extract dependencies
		names = [].concat(args[0]); // force to array TODO: create unit test when this is official
		callback = args[1];

		// this must be after extractCfg
		ctx = begetCtx('');

		var promise = new Promise(),
			api = {};

			// return the dependencies as arguments, not an array
			// using bracket property notation so closure won't clobber name
			api['then'] = function (resolved, rejected) {
				promise.then(
					function (deps) { if (resolved) resolved.apply(null, deps); },
					function (ex) { if (rejected) rejected(ex); else throw ex; }
				);
				return api;
			};

			// promise chaining
			api['next'] = function (names, cb) {
				var origPromise = promise;
				promise = new Promise();
				// wait for the previous promise
				origPromise.then(
					// get dependencies and then resolve the current promise
					function () { ctx.require(names, promise, ctx); },
					// fail the current promise
					function (ex) { promise.reject(ex); }
				);
				// execute this callback after dependencies
				if (cb) {
					promise.then(function (deps) {
						cb.apply(this, deps)
					});
				}
				return api;
			};

			if (callback) api['then'](callback);

		ctx.require(names, promise, ctx);

		return api;

	}

	function _define (/* various */) {

		var args = fixArgs(arguments),
			name = args.name;

		if (name == null) {
			if (argsNet !== undef) {
				argsNet = {ex: 'Multiple anonymous defines found in ${url}.'};
			}
			else if (!(name = getCurrentDefName())/* intentional assignment */) {
				// anonymous define(), defer processing until after script loads
				argsNet = args;
			}
		}
		if (name != null) {
			// named define(), it is in the cache if we are loading a dependency
			// (could also be a secondary define() appearing in a built file, etc.)
			// if it's a secondary define(), grab the current def's context
			var def = cache[name];
			if (!def) {
				def = cache[name] = new ResourceDef(name);
			}
			def.useNet = false;
			// check if this resource has already been resolved (can happen if
			// a module was defined inside a built file and outside of it and
			// dev didn't coordinate it explicitly)
			if (!('resolved' in def)) {
				resolveResDef(def, args, begetCtx(name));
			}
		}

	}

	/***** grab any global configuration info *****/

	// if userCfg is a function, assume curl() exists already
	var conflict = isType(userCfg, 'Function');
	if (!conflict) {
		extractCfg(userCfg);
	}

	/***** define public API *****/

	// allow curl to be renamed and added to a specified context
	var apiName, apiContext;

	apiName = userCfg['apiName'] || 'curl';
	apiContext = userCfg['apiContext'] || global;

	apiContext[apiName] = _curl;
	cache[apiName] = new ResourceDef(apiName);
	cache[apiName].resolve(_curl);

	// using bracket property notation so closure won't clobber name
	global['define'] = _curl['define'] = _define;
	_curl['version'] = version;

	// this is to comply with the AMD CommonJS proposal:
	_define['amd'] = { plugins: true };

}(
	this,
	document,
	// grab configuration
	this['curl'] || {}
));
/**
 * curl domReady
 *
 * (c) copyright 2011, unscriptable.com / John Hann
 * Licensed under the MIT License at:
 * 		http://www.opensource.org/licenses/mit-license.php
 *
 * usage:
 *  require(['ModuleA', 'curl/domReady'], function (ModuleA, domReady) {
 * 		var a = new ModuleA();
 * 		domReady(function () {
 * 			document.body.appendChild(a.domNode);
 * 		});
 * 	});
 *
 * also: check out curl's domReady! plugin
 *
 * HT to Bryan Forbes who wrote the initial domReady code:
 * http://www.reigndropsfall.net/
 *
 */
(function (global, doc) {

	var
		readyState = 'readyState',
		// keep these quoted so closure compiler doesn't squash them
		readyStates = { 'loaded': 1, 'interactive': 1, 'complete': 1 },
		callbacks = [],
		fixReadyState = typeof doc[readyState] != "string",
		// IE needs this cuz it won't stop setTimeout if it's already queued up
		completed = false,
		pollerTime = 10,
		addEvent,
		remover,
		removers = [],
		pollerHandle,
		undef;

	function ready () {
		completed = true;
		clearTimeout(pollerHandle);
		while (remover = removers.pop()) remover();
		if (fixReadyState) {
			doc[readyState] = "complete";
		}
		// callback all queued callbacks
		var cb;
		while ((cb = callbacks.shift())) {
			cb();
		}
	}

	var testEl;
	function isDomManipulable () {
		// question: implement Diego Perini's IEContentLoaded instead?
		// answer: The current impl seems more future-proof rather than a
		// non-standard method (doScroll). i don't care if the rest of the js
		// world is using doScroll! They can have fun repairing their libs when
		// the IE team removes doScroll in IE 13. :)
		if (!doc.body) return false; // no body? we're definitely not ready!
		if (!testEl) testEl = doc.createTextNode('');
		try {
			// webkit needs to use body. doc
			doc.body.removeChild(doc.body.appendChild(testEl));
			testEl = undef;
			return true;
		}
		catch (ex) {
			return false;
		}
	}

	function checkDOMReady (e) {
		var isReady;
		// all browsers except IE will be ready when readyState == 'interactive'
		// so we also must check for document.body
		isReady = readyStates[doc[readyState]] && isDomManipulable();
		if (!completed && isReady) {
			ready();
		}
		return isReady;
	}

	function poller () {
		checkDOMReady();
		if (!completed) {
			pollerHandle = setTimeout(poller, pollerTime);
		}
	}

	// select the correct event listener function. all of our supported
	// browsers will use one of these
	if ('addEventListener' in global) {
		addEvent = function (node, event) {
			node.addEventListener(event, checkDOMReady, false);
			return function () { node.removeEventListener(event, checkDOMReady, false); };
		};
	}
	else {
		addEvent = function (node, event) {
			node.attachEvent('on' + event, checkDOMReady);
			return function () { node.detachEvent(event, checkDOMReady); };
		};
	}

	if (doc) {
		if (!checkDOMReady()) {
			// add event listeners and collect remover functions
			removers = [
				addEvent(global, 'load'),
				addEvent(doc, 'readystatechange'),
				addEvent(global, 'DOMContentLoaded')
			];
			// additionally, poll for readystate
			pollerHandle = setTimeout(poller, pollerTime);
		}
	}

	define(/*=='curl/domReady',==*/ function () {

		// this is simply a callback, but make it look like a promise
		function domReady (cb) {
			if (completed) cb(); else callbacks.push(cb);
		}
		domReady['then'] = domReady;
		domReady['amd'] = true;

		return domReady;

	});

}(this, document));
/**
 * curl domReady loader plugin
 *
 * (c) copyright 2011, unscriptable.com
 *
 * allows the curl/domReady module to be used like a plugin
 * this is for better compatibility with other loaders.
 *
 * Usage:
 *
 * curl(["domReady!"]).then(doSomething);
 *
 * TODO: use "../domReady" instead of "curl/domReady" when curl's make.sh is updated to use cram
 */

define(/*=='domReady',==*/ ['curl/domReady'], function (domReady) {

	return {

		'load': function (name, req, cb, cfg) {
			domReady(cb);
		}

	};

});
/**
 * curl js plugin
 *
 * (c) copyright 2011, unscriptable.com / John Hann
 * Licensed under the MIT License at:
 * 		http://www.opensource.org/licenses/mit-license.php
 *
 * usage:
 *  require(['ModuleA', 'js!myNonAMDFile.js!order', 'js!anotherFile.js!order], function (ModuleA) {
 * 		var a = new ModuleA();
 * 		document.body.appendChild(a.domNode);
 * 	});
 *
 * Specify the !order suffix for files that must be evaluated in order.
 *
 * Async=false rules learned from @getify's LABjs!
 * http://wiki.whatwg.org/wiki/Dynamic_Script_Execution_Order
 *
 */
(function (global, doc) {
"use strict";
	var queue = [],
		supportsAsyncFalse = doc.createElement('script').async == true,
		readyStates = { 'loaded': 1, 'interactive': 1, 'complete': 1 },
		orsc = 'onreadystatechange',
		head = doc['head'] || doc.getElementsByTagName('head')[0],
		waitForOrderedScript;

	// TODO: find a way to reuse the loadScript from curl.js
	function loadScript (def, success, failure) {
		// script processing rules learned from RequireJS

		var deadline, el;

		// default deadline is very far in the future (5 min)
		// devs should set something reasonable if they want to use it
		deadline = new Date().valueOf() + (def.timeout || 300) * 1000;

		// insert script
		el = doc.createElement('script');

		// initial script processing
		function process (ev) {
			ev = ev || global.event;
			// detect when it's done loading
			if (ev.type == 'load' || readyStates[el.readyState]) {
				// release event listeners
				el.onload = el[orsc] = el.onerror = "";
				if (!def.test || testGlobalVar(def.test)) {
					success(el);
				}
				else {
					fail();
				}
			}
		}

		function fail (e) {
			// some browsers send an event, others send a string,
			// but none of them send anything useful, so just say we failed:
			el.onload = el[orsc] = el.onerror = "";
			if (failure) {
				failure(new Error('Script error or http error: ' + def.url));
			}
		}

		// some browsers (Opera and IE6-8) don't support onerror and don't fire
		// readystatechange if the script fails to load so we need to poll.
		// this poller only runs if def.test is specified and failure callback
		// is defined (see below)
		function poller () {
			// if the script loaded
			if (el.onload && readyStates[el.readyState]) {
				process({});
			}
			// if neither process or fail as run and our deadline is in the past
			else if (el.onload && deadline < new Date()) {
				fail();
			}
			else {
				setTimeout(poller, 10);
			}
		}
		if (failure && def.test) setTimeout(poller, 10);

		// set type first since setting other properties could
		// prevent us from setting this later
		el.type = def.mimetype || 'text/javascript';
		// using dom0 event handlers instead of wordy w3c/ms
		el.onload = el[orsc] = process;
		el.onerror = fail;
		el.charset = def.charset || 'utf-8';
		el.async = def.async;
		el.src = def.url;

		// use insertBefore to keep IE from throwing Operation Aborted (thx Bryan Forbes!)
		head.insertBefore(el, head.firstChild);

	}

	function fetch (def, promise) {

		loadScript(def,
			function (el) {
				// if there's another queued script
				var next = queue.shift();
				waitForOrderedScript = queue.length > 0;
				if (next) {
					// go get it (from cache hopefully)
					fetch.apply(null, next);
				}
				promise['resolve'](el);
			},
			function (ex) {
				promise['reject'](ex);
			}
		);

	}

	function testGlobalVar (varName) {
		try {
			eval('global.' + varName);
			return true;
		}
		catch (ex) {
			return false;
		}
	}

	define(/*=='js',==*/ {
		'load': function (name, require, callback, config) {

			var order, testPos, test, prefetch, def, promise;

			order = name.indexOf('!order') > 0; // can't be zero
			testPos = name.indexOf('!test=');
			test = testPos > 0 && name.substr(testPos + 6); // must be last option!
			prefetch = 'prefetch' in config ? config['prefetch'] : true;
			name = order || testPos > 0 ? name.substr(0, name.indexOf('!')) : name;
			def = {
				name: name,
				url: require['toUrl'](name),
				async: !order,
				order: order,
				test: test,
				timeout: config.timeout
			};
			promise = callback['resolve'] ? callback : {
				'resolve': function (o) { callback(o); },
				'reject': function (ex) { throw ex; }
			};

			// if this script has to wait for another
			// or if we're loading, but not executing it
			if (order && !supportsAsyncFalse && waitForOrderedScript) {
				// push onto the stack of scripts that will be fetched
				// from cache. do this before fetch in case IE has file cached.
				queue.push([def, promise]);
				// if we're prefetching
				if (prefetch) {
					// go get the file under an unknown mime type
					def.mimetype = 'text/cache';
					loadScript(def,
						// remove the fake script when loaded
						function (el) { el.parentNode.removeChild(el); },
						false
					);
					def.mimetype = '';
				}
			}
			// otherwise, just go get it
			else {
				waitForOrderedScript = waitForOrderedScript || order;
				fetch(def, promise);
			}

		}
	});

}(this, document));
/**
 * Copyright (c) 2010 unscriptable.com
 */

(function (global) {
"use strict";

/*
 * curl link! plugin
 * This plugin will load css files as <link> elements.  It does not wait for
 * css file to finish loading / evaluating before executing dependent modules.
 * This plugin also does not handle IE's 31-stylesheet limit.
 * If you need any of the above behavior, use curl's css! plugin instead.
 *
 * All this plugin does is insert <link> elements in a non-blocking manner.
 *
 * usage:
 * 		// load myproj/comp.css and myproj/css2.css
 *      require(['link!myproj/comp,myproj/css2']);
 *      // load some/folder/file.css
 *      define(['css!some/folder/file'], {});
 *
 * Tested in:
 *      Firefox 1.5, 2.0, 3.0, 3.5, 3.6, and 4.0b6
 *      Safari 3.0.4, 3.2.1, 5.0
 *      Chrome 7+
 *      Opera 9.52, 10.63, and Opera 11.00
 *      IE 6, 7, and 8
 *      Netscape 7.2 (WTF? SRSLY!)
 * Does not work in Safari 2.x :(
*/


	var
		// compressibility shortcuts
		createElement = 'createElement',
		// doc will be undefined during a build
		doc = global.document,
		// regexp to find url protocol for IE7/8 fix (see fixProtocol)
		isProtocolRelativeRx = /^\/\//,
		// find the head element and set it to it's standard property if nec.
		head;

	if (doc) {
		head = doc.head || (doc.head = doc.getElementsByTagName('head')[0]);
	}

	function nameWithExt (name, defaultExt) {
		return name.lastIndexOf('.') <= name.lastIndexOf('/') ?
			name + '.' + defaultExt : name;
	}

	function createLink (doc, href) {
		var link = doc[createElement]('link');
		link.rel = "stylesheet";
		link.type = "text/css";
		link.href = href;
		return link;
	}

	function fixProtocol (url, protocol) {
		// IE 7 & 8 can't handle protocol-relative urls:
		// http://www.stevesouders.com/blog/2010/02/10/5a-missing-schema-double-download/
		return url.replace(isProtocolRelativeRx, protocol + '//');
	}

	define(/*=='link',==*/ {

		'load': function (resourceId, require, callback, config) {
			var url, link, fix;

			url = require['toUrl'](nameWithExt(resourceId, 'css'));
			fix = 'fixSchemalessUrls' in config ? config['fixSchemalessUrls'] : doc.location.protocol;
			url = fix ? fixProtocol(url, fix) : url;
			link = createLink(doc, url);
			head.appendChild(link);

			callback(link.sheet || link.styleSheet);

		}

	});

})(this);
/**
 * curl text loader plugin
 *
 * (c) copyright 2011, unscriptable.com
 *
 * TODO: load xdomain text, too
 * 
 */

define(/*=='text',==*/ function () {

	var progIds = ['Msxml2.XMLHTTP', 'Microsoft.XMLHTTP', 'Msxml2.XMLHTTP.4.0'],
		// collection of modules that have been written to the built file
		built = {};

	function xhr () {
		if (typeof XMLHttpRequest !== "undefined") {
			// rewrite the getXhr method to always return the native implementation
			xhr = function () { return new XMLHttpRequest(); };
		}
		else {
			// keep trying progIds until we find the correct one, then rewrite the getXhr method
			// to always return that one.
			var noXhr = xhr = function () {
					throw new Error("getXhr(): XMLHttpRequest not available");
				};
			while (progIds.length > 0 && xhr === noXhr) (function (id) {
				try {
					new ActiveXObject(id);
					xhr = function () { return new ActiveXObject(id); };
				}
				catch (ex) {}
			}(progIds.shift()));
		}
		return xhr();
	}

	function fetchText (url, callback, errback) {
		var x = xhr();
		x.open('GET', url, true);
		x.onreadystatechange = function (e) {
			if (x.readyState === 4) {
				if (x.status < 400) {
					callback(x.responseText);
				}
				else {
					errback(new Error('fetchText() failed. status: ' + x.statusText));
				}
			}
		};
		x.send(null);
	}

	function nameWithExt (name, defaultExt) {
		return name.lastIndexOf('.') <= name.lastIndexOf('/') ?
			name + '.' + defaultExt : name;
	}

	function error (ex) {
		if (console) {
			console.error ? console.error(ex) : console.log(ex.message);
		}
	}

	function jsEncode (text) {
		// TODO: hoist the map and regex to the enclosing scope for better performance
		var map = { 34: '\\"', 13: '\\r', 12: '\\f', 10: '\\n', 9: '\\t', 8: '\\b' };
		return text.replace(/(["\n\f\t\r\b])/g, function (c) {
			return map[c.charCodeAt(0)];
		});
	}

	return {

		load: function (resourceName, req, callback, config) {
			// remove suffixes (future)
			// hook up callbacks
			var cb = callback.resolve || callback,
				eb = callback.reject || error;
			// get the text
			fetchText(req['toUrl'](resourceName), cb, eb);
		},

		build: function (writer, fetcher, config) {
			// writer is a function used to output to the built file
			// fetcher is a function used to fetch a text file
			// config is the global config
			// returns a function that the build tool can use to tell this
			// plugin to write-out a resource
			return function write (pluginId, resource, resolver) {
				var url, absId, text, output;
				url = resolver['toUrl'](nameWithExt(resource, 'html'));
				absId = resolver['toAbsMid'](resource);
				if (!(absId in built)) {
					built[absId] = true;
					// fetch text
					text = jsEncode(fetcher(url));
					// write out a define
					output = 'define("' + pluginId + '!' + absId + '", function () {\n' +
						'\treturn "' + text + '";\n' +
					'});\n';
					writer(output);
				}
			};
		}

	};

});
/**
 * curl i18n plugin
 *
 * (c) copyright 2011, unscriptable.com
 *
 */

define(/*=='i18n',==*/ function () {

	

});
