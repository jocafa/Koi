/* Neuron */
define(['Impulse'], function (Impulse) {
	var cid = 0;

	function __bind (fn, obj) {
		return function () {
			return fn.apply(obj, arguments);
		}
	}

	var schedule;

	try {
		schedule = process.nextTick;
	} catch (e) {
		schedule = (function () {
			var queue = [];
			window.addEventListener('message', function (event) {
				if (event.source == window && event.data == 'NeuronTick' && queue.length > 0) {
					(queue.shift())();
				}
			});

			return function (fn) {
				window.postMessage('NeuronTick', window.location.origin);
			};
		})();
	}

	function Neuron () {
		this.cid = cid++;
		this.axonTerminals = {};

		this.bindResponders();
	}

	Neuron.prototype.bindResponders = function () {
		for (var fn in this) {
			if (fn.indexOf('respondTo') == 0) {
				this[fn] = __bind(this[fn], this);
			}
		}
	};

	Neuron.prototype.emit = function (impulse) {
		// Tell all the neurons connected to the axon terminals to absorb
		// an impulse
		var responderKey = 'respondTo' + impulse.type.replace(/./, function (c) {
			return c.toUpperCase();
		});

		for (var k in this.axonTerminals) {
			var terminal = this.axonTerminals[i];

			if (
				!(terminal.cid in impulse.log) &&
				responderKey in terminal &&
				typeof terminal[responderKey] == 'function'
			) {
				(function (impulse, responder) {
					schedule(function () {
						responder(impulse);
					});
				})(impulse.clone(), terminal[responderKey]);
			}
		}
	};

	Neuron.prototype.observe = function (stimulator) {
		stimulator.axonTerminals[this.cid] = this;
	};

	Neuron.prototype.stopObserving = function (stimulator) {
		delete stimulator.axonTerminals[this.cid];
	};

	Neuron.prototype.influence = function (target) {
		target.observe(this);
	};

	Neuron.prototype.stopInfluencing = function (target) {
		target.stopObserving(this);
	};

	return Neuron;
});
