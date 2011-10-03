var
	fs = require('fs'),
	path = require('path'),
	EventEmitter = require('events').EventEmitter,
	express = require('express'),
	everyauth = require('everyauth'),
	crypto = require('crypto'),
	url = require('url'),
	querystring = require('querystring'),
	socketio = require('socketio'),
	redis = require('redis'),
	colors = require('colors');

function Server () {
}
