define(['Impulse', 'Neuron'], function (Impulse, Neuron) {
	function Client () {
		Neuron.call(this, arguments);
	}

	Client.prototype = new Neuron;
	Client.prototype.constructor = Client;
	Client.superclass = Neuron.prototype;

	return Client;
});
