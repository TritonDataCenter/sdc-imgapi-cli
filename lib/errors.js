/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
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
    assert.object(options, 'options');
    assert.string(options.message, 'options.message');
    assert.string(options.code, 'options.code');
    assert.optionalObject(options.cause, 'options.cause');
    assert.optionalNumber(options.statusCode, 'options.statusCode');
    var self = this;

    var args = [];
    if (options.cause) args.push(options.cause);
    // Workaround silly printf-handling in verror s.t. a message with content
    // that looks like a printf code breaks its rendering.
    if (options.message) {
        args.push('%s');
        args.push(options.message);
    }
    WError.apply(this, args);

    var extra = Object.keys(options).filter(
        function (k) { return ['cause', 'message'].indexOf(k) === -1; });
    extra.forEach(function (k) {
        self[k] = options[k];
    });
}
util.inherits(ImgapiCliError, WError);


/**
 * Multiple errors in a group.
 */
function MultiError(errs) {
    assert.arrayOfObject(errs, 'errs');
    var lines = [format('multiple (%d) errors', errs.length)];
    for (var i = 0; i < errs.length; i++) {
        var err = errs[i];
        lines.push(format('    error (%s): %s', err.code, err.message));
    }
    ImgadmError.call(this, {
        cause: errs[0],
        message: lines.join('\n'),
        code: 'MultiError',
        exitStatus: 1
    });
}
util.inherits(MultiError, ImgapiCliError);


function InternalError(cause) {
    assert.object(cause);
    ImgapiCliError.call(this, {
        cause: cause,
        message: cause.message,
        code: 'InternalError',
        exitStatus: 1
    });
}
util.inherits(InternalError, ImgapiCliError);

function InvalidUUIDError(cause, uuid) {
    if (uuid === undefined) {
        uuid = cause;
        cause = undefined;
    }
    assert.string(uuid);
    ImgapiCliError.call(this, {
        cause: cause,
        message: sprintf('invalid uuid: "%s"', uuid),
        code: 'InvalidUUID',
        exitStatus: 1
    });
}
util.inherits(InvalidUUIDError, ImgapiCliError);

function InvalidManifestDataError(cause) {
    assert.optionalObject(cause);
    ImgapiCliError.call(this, {
        cause: cause,
        message: 'manifest data is not valid JSON',
        code: 'InvalidManifestData',
        exitStatus: 1
    });
}
util.inherits(InvalidManifestDataError, ImgapiCliError);

function UsageError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message);
    ImgapiCliError.call(this, {
        cause: cause,
        message: message,
        code: 'Usage',
        exitStatus: 1
    });
}
util.inherits(UsageError, ImgapiCliError);

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

/**
 * Error from the `imgapi.js` client. It will have a `.code` string field.
 */
function ClientError(cause) {
    assert.object(cause, 'cause');
    assert.string(cause.code, 'cause.code');
    ImgapiCliError.call(this, {
        cause: cause,
        message: String(cause),
        code: 'ClientError',
        exitStatus: 1
    });
}
ClientError.description = "An error from the IMGAPI client.";
util.inherits(ClientError, ImgapiCliError);


function APIError(cause) {
    assert.object(cause, 'cause');
    assert.optionalNumber(cause.statusCode, 'cause.statusCode');
    assert.string(cause.body.code, 'cause.body.code');
    assert.string(cause.body.message, 'cause.body.message');
    var message = cause.body.message || '(no message)';
    if (cause.body.errors) {
        cause.body.errors.forEach(function (e) {
            message += sprintf('\n    %s: %s', e.field, e.code);
            if (e.message) {
                message += ': ' + e.message;
            }
        });
    }
    ImgapiCliError.call(this, {
        cause: cause,
        message: message,
        code: cause.body.code,
        statusCode: cause.statusCode,
        exitStatus: 1
    });
}
APIError.description = "An error from the IMGAPI http request."
util.inherits(APIError, ImgapiCliError);


function DownloadError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.optionalObject(cause);
    assert.string(message);
    ImgapiCliError.call(this, {
        cause: cause,
        message: message,
        code: 'DownloadError'
    });
}
util.inherits(DownloadError, ImgapiCliError);


function UploadError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.optionalObject(cause);
    assert.string(message);
    ImgapiCliError.call(this, {
        cause: cause,
        message: message,
        code: 'UploadError'
    });
}
util.inherits(UploadError, ImgapiCliError);



//---- exports

module.exports = {
    ImgapiCliError: ImgapiCliError,
    MultiError: MultiError,
    InternalError: InternalError,
    InvalidUUIDError: InvalidUUIDError,
    InvalidManifestDataError: InvalidManifestDataError,
    UsageError: UsageError,
    UnknownOptionError: UnknownOptionError,
    UnknownCommandError: UnknownCommandError,
    ClientError: ClientError,
    APIError: APIError,
    DownloadError: DownloadError,
    UploadError: UploadError
};
