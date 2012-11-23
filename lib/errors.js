/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Error classes that imgapi-cli may produce.
 */

var util = require('util');
var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var WError = require('verror').WError;



//---- error classes

/**
 * Base imgapi-cli error. Instances will always have a string `message` and
 * a string `code` (a CamelCase string). The possible codes are those
 * for every error subclass here, plus the possible `restCode` error
 * responses from IMGAPI.
 * See <https://mo.joyent.com/docs/imgapi/master/#errors>.
 */
function ImgapiCliError(options) {
    assert.object(options);
    assert.optionalObject(options.cause);
    assert.string(options.message);
    assert.string(options.code);
    var self = this;

    var args = [];
    if (options.cause) args.push(options.cause);
    args.push(options.message);
    WError.apply(this, args);

    var extra = Object.keys(options).filter(
        function (k) { return ['cause', 'message'].indexOf(k) === -1; });
    extra.forEach(function (k) {
        self[k] = options[k];
    });
}
util.inherits(ImgapiCliError, WError);

function UnknownOptionError(cause, option) {
    if (option === undefined) {
        option = cause;
        cause = undefined;
    }
    assert.string(option);
    ImgapiCliError.call(this, {
        cause: cause,
        message: sprintf('unknown option: "%s"', option),
        code: 'UnknownOption',
        exitStatus: 1
    });
}
util.inherits(UnknownOptionError, ImgapiCliError);

function UnknownCommandError(cause, command) {
    if (command === undefined) {
        command = cause;
        cause = undefined;
    }
    assert.string(command);
    ImgapiCliError.call(this, {
        cause: cause,
        message: sprintf('unknown command: "%s"', command),
        code: 'UnknownCommand',
        exitStatus: 1
    });
}
util.inherits(UnknownCommandError, ImgapiCliError);

function APIError(cause) {
    assert.object(cause);
    assert.string(cause.restCode);
    assert.string(cause.body.message);
    ImgapiCliError.call(this, {
        cause: cause,
        message: cause.body.message,
        code: cause.restCode,
        exitStatus: 1
    });
}
APIError.description = "An error from the IMGAPI http request."
util.inherits(APIError, ImgapiCliError);





//---- exports

module.exports = {
    ImgapiCliError: ImgapiCliError,
    UnknownOptionError: UnknownOptionError,
    UnknownCommandError: UnknownCommandError,
    APIError: APIError
};
