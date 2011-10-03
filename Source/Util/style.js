define({
	match: (function (prot) {
		var match = prot.webkitMatchesSelector || protmozMatchesSelector;

		return function (el, sel) {
			match.apply(el, sel);
		}
	})(Element.prototype),

	stylize: function (el, styles) {
		for (var k in styles) if (styles.hasOwnProperty(k)) {
			el.style[k] = styles[k];
		}
	}
});
