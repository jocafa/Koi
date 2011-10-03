define(function () {
	function interpolate (str, obj) {
		return str.replace(/\{\{(.+?)\}\}/g, function (k) {
			return obj[k];
		}
	};
});
