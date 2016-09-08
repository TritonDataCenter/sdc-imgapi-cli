/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * The main entry point for an imgapi-cli instance.
 */

var util = require('util'),
    format = util.format;
var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var assert = require('assert-plus');
var nopt = require('nopt');
var sprintf = require('extsprintf').sprintf;
var imgapi = require('sdc-clients/lib/imgapi');
var bunyan = require('bunyan');
var ProgressBar = require('progbar').ProgressBar;
var restify = require('sdc-clients/node_modules/restify');
var strsplit = require('strsplit');
var tabula = require('tabula');
var vasync = require('vasync');

var common = require('./common'),
    objCopy = common.objCopy;
var errors = require('./errors');



//---- internal support stuff

var DEFAULT_IDENTITY_FILES = [];
if (process.env.HOME) {
    DEFAULT_IDENTITY_FILES.push(path.resolve(process.env.HOME, '.ssh/id_rsa'));
}


var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function assertUuid(uuid) {
    if (!UUID_RE.test(uuid)) {
        throw new errors.InvalidUUIDError(uuid);
    }
}

// The name of the event on a write stream indicating it is done.
var nodeVer = process.versions.node.split('.').map(Number);
var writeStreamFinishEvent = 'finish';
if (nodeVer[0] === 0 && nodeVer[1] <= 8) {
    writeStreamFinishEvent = 'close';
}


/**
 * Ensure that the necessary options for adding a file are present.
 *
 * @param opts {Object} A subcmd options object using `file` and
 *      `compression` if appropriate.
 *      Note: This object may be modified in-place.
 * @param callback {Function} `function (err)`
 */
function ensureAddFileOpts(opts, callback) {
    if (!opts.file) {
        // No need.
        return callback();
    }
    if (!opts.compression) {
        var ext = path.extname(opts.file);
        opts.compression = {'.bz2': 'bzip2', '.gz': 'gzip'}[ext];
    }
    if (!opts.compression) {
        return callback(new errors.UsageError(format(
            'could not determine file compression, use "-c" option')));
    }
    var VALID_COMPRESSIONS = ['bzip2', 'gzip', 'none'];
    if (VALID_COMPRESSIONS.indexOf(opts.compression) === -1) {
        return callback(new errors.UsageError(format(
            'invalid compression "%s": must be one of %s', opts.compression,
            VALID_COMPRESSIONS.join(', '))));
    }
    callback();
}


/**
 * Ensure that the necessary options for adding an icon are present.
 *
 * @param opts {Object} A subcmd options object using `file` and
 *      `contentType` if appropriate.
 *      Note: This object may be modified in-place.
 * @param callback {Function} `function (err)`
 */
function ensureAddIconOpts(opts, callback) {
    if (!opts.file) {
        // No need.
        return callback();
    }

    var ext;
    if (opts.contentType) {
        ext = format('.%s', opts.contentType);
    } else {
        ext = path.extname(opts.file);
    }
    // Convert ext to content-type header
    opts.contentType = {
        '.jpeg': 'image/jpeg',
        '.jpg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif'
    }[ext];

    var VALID_CONTENT_TYPES = ['jpeg', 'png', 'gif'];
    if (!opts.contentType) {
        return callback(new errors.UsageError(format(
            'could not determine a valid content type, must be one of %s',
            VALID_CONTENT_TYPES.join(', '))));
    }
    callback();
}


//---- CLI object

/**
 * Create an IMGAPI CLI instance.
 *
 * @param options {Object}:
 *      - @param name {String} Required. The CLI name, e.g. "joyent-imgadm".
 *      - @param url {String} Required. The IMGAPI URL.
 *      - @param description {String} Optional.
 *      - @param auth {String} Optional. One of "none" (default), "basic",
 *          "signature". This will impact what CLI options are available
 *          and auth used (if any) on requests to the IMGAPI.
 *      - @param envopts {Array} Optional. An ordered mapping of envvar name
 *          to associated CLI options. E.g.
 *                  [['FOO_CLI_IDENTITY': 'identity'], ...]
 *          will result in `--identity=$FOO_CLI_IDENTITY` effectively being
 *          added to argv if `--identity` wasn't already specified.
 *      - @param features {Array} Optional. An array of optional CLI features.
 *          Typically these map to different capabilities of the IMGAPI
 *          endpoint this CLI instance will speak to. Features are:
 *              "export"    Enables the "*-imgadm export" function which
 *                          calles "ExportImage" on the target IMGAPI.
 *              "channels"  Enables channel-related functionally, i.e. if the
 *                          target IMGAPI supports image channels.
 *      - @param connectTimeout {Number} Optional. Number of millisecond
 *          timeout for socket connection for client requests.
 */
function CLI(options) {
    assert.object(options, 'options');
    assert.string(options.name, 'options.name');
    assert.optionalString(options.description, 'options.description');
    assert.string(options.url, 'options.url');
    assert.optionalString(options.auth, 'options.auth');
    assert.optionalArrayOfObject(options.envopts, 'options.envopts');
    assert.optionalArrayOfString(options.features, 'options.features');
    assert.optionalNumber(options.connectTimeout, 'options.connectTimeout');

    var self = this;
    this.auth = options.auth || 'none';
    assert.ok(['none', 'basic', 'signature'].indexOf(this.auth) !== -1);
    this.name = options.name;
    this.description = options.description;
    this.url = options.url;
    this.envopts = options.envopts;
    this._connectTimeout = options.connectTimeout;

    // Handle features.
    self.features = {};
    (options.features || []).forEach(function (feat) {
        self.features[feat] = true;
    });
    if (!self.features['export']) {
        delete self.constructor.prototype['do_export'];
    }
    if (!self.features['channels']) {
        delete self.constructor.prototype['do_channels'];
        delete self.constructor.prototype['do_channel_add'];
    } else {
        self.constructor.prototype.do_delete.description =
            self.constructor.prototype.do_delete._channels_description;
        self.constructor.prototype.do_delete.longOpts =
            self.constructor.prototype.do_delete._channels_longOpts;
    }

    this.subcmds = {};
    this.aliases = {};
    Object.keys(this.constructor.prototype)
        .filter(function (funcname) { return /^do_/.test(funcname); })
        .sort()
        .forEach(function (funcname) {
            var name = funcname.slice(3).replace(/_/g, '-');
            var func = self.constructor.prototype[funcname];
            self.subcmds[name] = func;
            self.aliases[name] = name;
            (func.aliases || []).forEach(function (alias) {
                self.aliases[alias] = name;
            });
        });

    this.helpcmds = {};
    Object.keys(this.constructor.prototype)
        .filter(function (funcname) { return /^help_/.test(funcname); })
        .sort()
        .forEach(function (funcname) {
            var name = funcname.slice(5);
            var func = self.constructor.prototype[funcname];
            self.helpcmds[name] = func;
        });
}


/**
 * CLI mainline.
 *
 * @param argv {Array}
 * @param callback {Function} `function (err, verbose)`
 *      Where `verbose` is a boolean indicating if verbose output was
 *      requested by user options.
 */
CLI.prototype.main = function main(argv, callback) {
    var self = this;
    this.handleArgv(argv, this.envopts, function (err, opts) {
        if (err) {
            return callback(err);
        }

        var verbose = Boolean(opts.debug);
        var args = opts.argv.remain;
        if (opts.version) {
            console.log(self.name + ' ' + common.getVersion());
            return callback(null, verbose);
        }
        if (args.length === 0) {
            return self.printHelp(function (aerr) { callback(aerr, verbose); });
        } else if (opts.help) {
            // We want `cli foo -h` to show help for the 'foo' subcmd.
            if (args[0] !== 'help') {
                return self.do_help(args[0], opts, args, callback);
            }
        }

        /*
         * Logging is to stderr. By default we log at the 'warn' level -- but
         * that is almost nothing. Logging is in Bunyan format (hence very
         * limited default logging), so need to pipe via `bunyan` for readable
         * output (at least until bunyan.js supports doing it inline).
         *
         * Admittedly this is a bit of a pain:
         *
         *      imgapi-cli ping -d 2>&1 | bunyan
         *
         * Use -d|--debug to increase the logging to trace, and enable
         * 'src' (source file location information)
         */
        var level = 'warn';
        var src = false;
        if (opts.debug) {
            level = 'trace';
            src = true;
        }
        self.log = bunyan.createLogger({
            name: self.name,
            streams: [ {
                stream: process.stderr,
                level: level
            }],
            src: src,
            // https://github.com/mcavage/node-restify/pull/501 is fixed
            serializers: restify.bunyan.serializers
        });
        self.log.debug({opts: opts, argv: argv}, 'parsed argv');
        var imgapiOpts = {
            url: self.url,
            log: self.log.child({component: 'api'}, true)
        };
        if (self.auth === 'basic') {
            imgapiOpts.user = opts.user;
            imgapiOpts.password = opts.password;
            self.log.info({user: imgapiOpts.user}, 'basic auth');
        } else if (self.auth === 'signature') {
            // TODO: decide on whether '-i identity' (ssh) or '-k keyId' (manta)
            // style.
            if (opts.user && opts.identities) {
                imgapiOpts.sign = imgapi.cliSigner({
                    keyIds: opts.identities,
                    log: imgapiOpts.log,
                    user: opts.user
                });
            }
            imgapiOpts.user = opts.user;
            self.log.info({user: imgapiOpts.user || '(none)',
                identities: opts.identities || '(none)'},
                'signature auth');
        }
        if (self.features.channels && opts.channel) {
            imgapiOpts.channel = opts.channel;
        }
        if (self._connectTimeout) {
            imgapiOpts.connectTimeout = self._connectTimeout;
        }
        imgapiOpts.rejectUnauthorized = !opts.insecure;
        self.client = imgapi.createClient(imgapiOpts);

        var subcmd = args.shift();
        try {
            self.dispatch(subcmd, argv, function (aerr) {
                self.client.close();
                callback(aerr, verbose);
            });
        } catch (ex) {
            self.client.close();
            callback(ex, verbose);
        }
    });
};


/**
 * Process options.
 *
 * @param argv {Array}
 * @param envopts {Array} Array or 2-tuples mapping envvar name to option for
 *      which it is a fallback.
 * @param callback {Function} `function (err, opts)`.
 */
CLI.prototype.handleArgv = function handleArgv(argv, envopts, callback) {
    var longOpts = this.longOpts = {
        'help': Boolean,
        'version': Boolean,
        'debug': Boolean,
        'insecure': Boolean
    };
    var shortOpts = this.shortOpts = {
        'h': ['--help'],
        'd': ['--debug']
    };
    if (this.auth === 'basic') {
        longOpts.user = String;
        shortOpts.u = ['--user'];
    } else if (this.auth === 'signature') {
        longOpts.user = String;
        shortOpts.u = ['--user'];
        longOpts.identity = [String, Array];
        shortOpts.i = ['--identity'];
    }
    if (this.features.channels) {
        longOpts.channel = String;
        shortOpts.C = ['--channel'];
    }

    var opts = nopt(longOpts, shortOpts, argv, 2);

    // envopts
    (envopts || []).forEach(function (envopt) {
        var envname = envopt[0];
        var optname = envopt[1];
        if (process.env[envname] && !opts[optname]) {
            //console.log('set `opts.%s = "%s" from %s envvar',
            //    optname, process.env[envname], envname);
            opts[optname] = process.env[envname];
        }
    });
    if (opts.identity) {
        if (!Array.isArray(opts.identity)) {
            opts.identities = [opts.identity];
        } else {
            opts.identities = opts.identity;
        }
        delete opts.identity;
    }

    if (this.auth === 'signature') {
        if (!opts.identities) {
            for (var i = 0; i < DEFAULT_IDENTITY_FILES.length; i++) {
                var f = DEFAULT_IDENTITY_FILES[i];
                if (fs.existsSync(f)) {
                    opts.identities = [f];
                    break;
                }
            }
        }
        callback(null, opts);
    } else if (this.auth === 'basic') {
        if (opts.user) {
            if (opts.user.indexOf(':') === -1) {
                var prompt = format('Enter IMGAPI password for user "%s": ',
                    opts.user);
                common.getPassword(prompt, function (err, password) {
                    if (err) {
                        return callback(err);
                    }
                    opts.password = password;
                    callback(null, opts);
                });
            } else {
                var colon = opts.user.indexOf(':');
                opts.password = opts.user.slice(colon + 1);
                opts.user = opts.user.slice(0, colon);
                callback(null, opts);
            }
        } else {
            callback(null, opts);
        }
    } else {
        callback(null, opts);
    }
};

CLI.prototype.printHelp = function printHelp(callback) {
    var self = this;

    var lines = [];
    if (this.description) {
        lines.push(this.description);
    }

    lines = lines.concat([
        'Usage:',
        '    %s [OPTIONS] COMMAND [ARGS...]',
        '    %s help COMMAND',
        '',
        'Options:',
        '    -h, --help          Show this help message and exit.',
        '    --version           Show version and exit.',
        '    -d, --debug         Verbose logging.',
        '    --insecure          Do not validate a TLS certificate.'
    ]);
    if (this.auth === 'basic') {
        lines = lines.concat([
            '    -u, --user <user:password>',
            '                    Basic auth user and (optionally) password.',
            '                    If no password is given, you will be prompted.'
        ]);
    } else if (this.auth === 'signature') {
        lines = lines.concat([
            '    -u, --user <user>   Username',
            '    -i <identity-file>  Path to identity file (private RSA key).'
        ]);
    }
    if (self.features.channels) {
        lines = lines.concat([
            '    -C, --channel <ch>  Image channel. Use "%s channels" to list',
            '                        server channels.'
        ]);
    }

    if (self.envopts && self.envopts.length) {
        var envTemplate = '    %-23s  %s';
        lines.push('');
        lines.push('Environment:');
        self.envopts.forEach(function (envopt) {
            var envname = envopt[0];
            var optname = envopt[1];
            lines.push(sprintf(envTemplate, envname, 'Fallback for --' +
                optname));
        });
    }

    var cmdTemplate = '    %-18s  %s';
    lines = lines.concat([
        '',
        'Commands:'
    ]);
    Object.keys(this.subcmds).forEach(function (name) {
        var func = self.subcmds[name];
        if (func.hidden) {
            return;
        }
        var names = name;
        if (func.aliases) {
            names += sprintf(' (%s)', func.aliases.join(', '));
        }
        var desc = (func.description ?
            func.description.split('\n', 1)[0] : '');
        desc = desc.replace(/\$NAME/g, self.name);
        var line = sprintf(cmdTemplate, names, desc);
        lines.push(line);
    });
    console.log(lines.join('\n').replace(/%s/g, this.name));
    callback();
};

/**
 * Dispatch to the appropriate "do_SUBCMD" function.
 */
CLI.prototype.dispatch = function dispatch(subcmd, argv, callback) {
    var self = this;
    var name = this.aliases[subcmd];
    if (!name) {
        return callback(new errors.UnknownCommandError(subcmd));
    }
    var func = this.subcmds[name];

    // Reparse the whole argv with merge global and subcmd options. This
    // is the only way (at least with `nopt`) to correctly parse subcmd opts.
    // It has the bonus of allowing *boolean* subcmd options before the
    // subcmd name, if that is helpful. E.g.:
    //      `joyent-imgadm -u trentm -j images`
    var longOpts = objCopy(this.longOpts);
    if (func.longOpts) {
        Object.keys(func.longOpts).forEach(
            function (k) { longOpts[k] = func.longOpts[k]; });
    }
    var shortOpts = objCopy(this.shortOpts);
    if (func.shortOpts) {
        Object.keys(func.shortOpts).forEach(
            function (k) { shortOpts[k] = func.shortOpts[k]; });
    }
    var opts = nopt(longOpts, shortOpts, argv, 2);
    self.log.trace({opts: opts, argv: argv}, 'parsed subcmd argv');

    // Die on unknown opts.
    var extraOpts = objCopy(opts);
    delete extraOpts.argv;
    Object.keys(longOpts).forEach(function (o) { delete extraOpts[o]; });
    extraOpts = Object.keys(extraOpts);
    if (extraOpts.length) {
        return callback(new errors.UnknownOptionError(extraOpts.join(', ')));
    }

    var args = opts.argv.remain;
    delete opts.argv;
    assert.equal(subcmd, args.shift());
    return func.call(this, subcmd, opts, args, callback);
};

CLI.prototype.do_help = function do_help(subcmd, opts, args, callback) {
    var self = this;
    if (args.length === 0) {
        return this.printHelp(callback);
    }
    var alias = args[0];
    var name = this.aliases[alias];
    if (!name) {
        return callback(new errors.UnknownCommandError(alias));
    }

    // If there is a `.help_NAME`, use that.
    var helpfunc = this.helpcmds[name];
    if (helpfunc) {
        return helpfunc.call(this, alias, callback);
    }

    var func = this.subcmds[name];
    if (func.description) {
        var desc = func.description.replace(/\$NAME/g, self.name).trimRight();
        console.log(desc);
        callback();
    } else {
        callback(new errors.ImgapiCliError(format('no help for "%s"', alias)));
    }
};
CLI.prototype.do_help.aliases = ['?'];
CLI.prototype.do_help.description =
'Give detailed help on a specific sub-command.';

CLI.prototype.help_help = function help_help(subcmd, callback) {
    this.printHelp(callback);
};


CLI.prototype._errorFromClientError = function _errorFromClientError(err) {
    assert.object(err, 'err');
    if (err.body && err.body.code) {
        return new errors.APIError(err);
    } else if (err.code) {
        return new errors.ClientError(err);
    } else {
        return new errors.InternalError(err);
    }
};


CLI.prototype.do_ping = function do_ping(subcmd, opts, args, callback) {
    var self = this;
    if (args.length) {
        return callback(new errors.UsageError(
            'unexpected args: ' + args.join(' ')));
    }
    this.client.ping(function (err, pong, res) {
        self.log.trace({err: err, res: res}, 'Ping');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        console.log(JSON.stringify(pong, null, 2));
        callback();
    });
};
CLI.prototype.do_ping.description = 'Ping the IMGAPI to see if it is up.';


CLI.prototype.do_state = function do_state(subcmd, opts, args, callback) {
    var self = this;
    if (args.length) {
        return callback(new errors.UsageError(
            'unexpected args: ' + args.join(' ')));
    }
    this.client.adminGetState(function (err, state, res) {
        self.log.trace({err: err, res: res}, 'AdminGetState');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        console.log(JSON.stringify(state, null, 2));
        callback();
    });
};
CLI.prototype.do_state.hidden = true;
CLI.prototype.do_state.description = (
    'Dump some IMGAPI internal state (for debugging).\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME state\n'
);


CLI.prototype.do_reload_auth_keys = function do_reload_auth_keys(
        subcmd, opts, args, callback) {
    var self = this;
    if (args.length) {
        return callback(new errors.UsageError(
            'unexpected args: ' + args.join(' ')));
    }
    this.client.adminReloadAuthKeys(function (err, state, res) {
        self.log.trace({err: err, res: res}, 'AdminReloadAuthKeys');
        if (err) {
            callback(self._errorFromClientError(err));
        } else {
            callback();
        }
    });
};
CLI.prototype.do_reload_auth_keys.description = (
    'Request that the server reload auth keys.\n' +
    '\n' +
    'This is for use by administrators of the IMGAPI server, and is only\n' +
    'relevant for servers that use HTTP Signature auth.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME reload-auth-keys\n'
);


CLI.prototype.do_list = function do_list(subcmd, opts, args, callback) {
    var self = this;
    var filters = {};
    var listOpts = {};
    if (opts.all) {
        filters.state = 'all';
    }
    if (opts.marker) {
        assert.string(opts.marker);
        filters.marker = opts.marker;
    }
    if (opts.limit) {
        filters.limit = opts.limit;
    }
    if (opts.inclAdminFields) {
        listOpts.inclAdminFields = opts.inclAdminFields;
    }

    for (var i = 0; i < args.length; i++) {
        var arg = args[i];
        var idx = arg.indexOf('=');
        if (idx === -1) {
            return callback(new errors.UsageError(format(
                'invalid filter: "%s" (must be of the form "field=value")',
                arg)));
        }
        filters[arg.slice(0, idx)] = arg.slice(idx + 1);
    }
    this.client.listImages(filters, listOpts, function (err, images, res) {
        self.log.trace({err: err, res: res}, 'ListImages');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        if (opts.latest) {
            var imageFromOwnerName = {};
            for (var j = 0; j < images.length; j++) {
                var image = images[j];
                var ownerName = image.owner + ':' + image.name;
                if (!imageFromOwnerName[ownerName] ||
                    image.published_at >
                        imageFromOwnerName[ownerName].published_at)
                {
                    imageFromOwnerName[ownerName] = image;
                }
            }
            images = Object.keys(imageFromOwnerName).map(
                function (oN) { return imageFromOwnerName[oN]; });
        }
        /*JSSTYLED*/
        var sortFields = (opts.sort || 'published_at,name').split(/,/g);
        tabula.sortArrayOfObjects(images, sortFields);
        if (opts.json) {
            console.log(JSON.stringify(images, null, 2));
        } else {
            images.forEach(function (img) {
                if (img.published_at) {
                    // Just the date.
                    img.published_date = img.published_at.slice(0, 10);
                    // Normalize on no milliseconds.
                    img.published = img.published_at.replace(/\.\d+Z$/, 'Z');
                }
                if (img.files && img.files[0]) {
                    img.size = img.files[0].size;
                    img.stor = img.files[0].stor;
                }
                var flags = [];
                if (img.origin) flags.push('I');
                if (img['public']) flags.push('P');
                if (img.state !== 'active') flags.push('X');
                img.flags = flags.length ? flags.join('') : undefined;
            });
            try {
                var columns = opts.output;
                if (!columns) {
                    if (filters.state) {
                        columns = 'uuid,name,version,flags,os,state,published';
                    } else {
                        columns = 'uuid,name,version,flags,os,published';
                    }
                }
                for (var k = 0; k < images.length; k++) {
                    if (images[k].channels) {
                        images[k].channels = images[k].channels.join(',');
                    }
                }
                tabula(images, {
                    skipHeader: opts.skipHeader,
                    /*JSSTYLED*/
                    columns: columns.split(/,/g),
                    validFields: ('uuid,owner,name,version,state,disabled,' +
                        'public,published,published_at,published_date,type,' +
                        'os,urn,nic_driver,disk_driver,cpu_type,image_size,' +
                        'generate_passwords,description,origin,flags,size,' +
                        /*JSSTYLED*/
                        'stor,homepage,channels').split(/,/g)
                });
            } catch (e) {
                return callback(e);
            }
        }
        callback();
    });
};
CLI.prototype.do_list.description = (
    /* BEGIN JSSTYLED */
    'List images.\n' +
    '\n' +
    'For full details on filter fields, see\n' +
    '<https://mo.joyent.com/docs/imgapi/master/#ListImages>.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME list [OPTIONS] [FILTERS]\n' +
    '\n' +
    'Filters:\n' +
    '    FIELD=VALUE        Field equality filter. Supported fields: \n' +
    '                       account, owner, state, name, os, and type.\n' +
    '    FIELD=true|false   Field boolean filter. Supported fields: public.\n' +
    '    FIELD=~SUBSTRING   Field substring filter. Supported fields: name\n' +
    '\n' +
    'Fields (most are self explanatory, some special ones are discussed):\n' +
    '    flags              This is a set of single letter flags\n' +
    '                       summarizing some fields. "P" indicates the\n' +
    '                       image is public. "I" indicates an incremental\n' +
    '                       image (i.e. has an origin). "X" indicates an\n' +
    '                       image with a state *other* than "active".\n' +
    '    published_date     Short form of "published_at" with just the date\n' +
    '    published          Short form of "published_at" elliding milliseconds.\n' +
    '    size               The number of bytes of the image file (files.0.size)\n' +
    '    stor               The backend storage for this image\'s files. This\n' +
    '                       requires "-A".\n' +
    '\n' +
    'Filtering Options:\n' +
    '    -a, --all          List all images, not just "active" ones. This\n' +
    '                       is a shortcut for the "state=all" filter.\n' +
    '    -m, --marker ARG   Only list images that with "published_at" greater\n' +
    '                       than or equal to that of the given image *UUID*\n' +
    '                       or given *date string*.\n' +
    '    -l, --limit NUM    Maximum number of images to return. Images are\n' +
    '                       sorted by creation date (ASC) by default.\n' +
    // TODO: add --incl-admin-fields when using dashdash for opts
    '    -A                 Allow administrator fields to be returned. This\n' +
    '                       may require auth.\n' +
    '\n' +
    'Output Options:\n' +
    '    -j, --json         JSON output\n' +
    '    -H                 Do not print table header row\n' +
    '    -o field1,...      Specify fields (columns) to output.\n' +
    '    -s field1,...      Sort on the given fields. Default is\n' +
    '                       "published_at,name".\n' +
    '    --latest           Only show the latest image, by published_at,\n' +
    '                       for a given (owner, name) set\n'
    /* END JSSTYLED */
);
CLI.prototype.do_list.longOpts = {
    'json': Boolean,
    'skipHeader': Boolean,
    'output': String,
    'sort': String,
    'all': Boolean,
    'latest': Boolean,
    'marker': String,
    'limit': Number,
    'inclAdminFields': Boolean
};
CLI.prototype.do_list.shortOpts = {
    'j': ['--json'],
    'H': ['--skipHeader'],
    'o': ['--output'],
    's': ['--sort'],
    'a': ['--all'],
    'm': ['--marker'],
    'l': ['--limit'],
    'A': ['--inclAdminFields']
};


CLI.prototype.do_get = function do_get(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);

    var getOpts = {};
    if (opts.inclAdminFields) {
        getOpts.inclAdminFields = opts.inclAdminFields;
    }

    this.client.getImage(uuid, getOpts, function (err, image, res) {
        self.log.trace({err: err, res: res}, 'GetImage');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        console.log(JSON.stringify(image, null, 2));
        callback();
    });
};
CLI.prototype.do_get.description = (
    'Get an image manifest.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME get [OPTIONS] UUID\n' +
    '\n' +
    'Options\n' +
    '    -h, --help         Show this help and exit.\n' +
    // TODO: add --incl-admin-fields when using dashdash for opts
    '    -A                 Allow administrator fields to be returned. This\n' +
    '                       may require auth.\n' +
    '\n' +
    'If the IMGAPI server supports channels, then by default only the\n' +
    'current set channel (or the server\'s default channel if not set)\n' +
    'is searched. To look in all channels, use:\n' +
    '\n' +
    '    $NAME -C "*" get UUID'

);
CLI.prototype.do_get.aliases = ['show', 'info'];
CLI.prototype.do_get.longOpts = {
    'inclAdminFields': Boolean
};
CLI.prototype.do_get.shortOpts = {
    'A': ['--inclAdminFields']
};


CLI.prototype.do_get_file = function do_get_file(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);
    assert.ok(!(opts.output && opts.outputUuidExt),
        'cannot use both "-o <file>" and "-O" options');

    function getOutputPath(next) {
        if (opts.output) {
            next(null, opts.output);
        } else if (opts.outputUuidExt) {
            self.client.getImage(uuid, function (imageErr, image, res) {
                if (imageErr)
                    return next(self._errorFromClientError(imageErr));
                var ext = {
                    'bzip2': '.bz2',
                    'gzip': '.gz',
                    'none': ''
                }[image.files[0].compression || 'none'];
                next(null, format('%s-file%s', uuid, ext));
            });
        } else {
            next();  // undefined means <stdout>
        }
    }
    getOutputPath(function (pathErr, outputPath) {
        if (pathErr) {
            return callback(pathErr);
        }

        var bar = null;
        var hash = null;
        var md5Expected = null;
        var finished = false;
        function finish(err) {
            if (finished)
                return;
            finished = true;
            if (bar) {
                bar.end();
            }
            if (outputPath) {
                console.error('Saved "%s".', outputPath);
            }
            if (hash && !err) {
                assert.string(md5Expected, 'headers["Content-MD5"]');
                var md5Actual = hash.digest('base64');
                if (md5Actual !== md5Expected) {
                    err = new errors.DownloadError(format(
                        'Content-MD5 expected to be %s, but was %s',
                        md5Expected, md5Actual));
                }
            }
            callback(err);
        }

        self.client.getImageFileStream(uuid, function (err, stream) {
            self.log.trace({err: err, res: stream}, 'GetImageFileStream');
            var outStream;
            if (err) {
                return callback(self._errorFromClientError(err));
            } else if (!outputPath) {
                outStream = stream.pipe(process.stdout);
            } else {
                if (!opts.quiet && process.stderr.isTTY) {
                    bar = new ProgressBar({
                        size: Number(stream.headers['content-length']),
                        filename: uuid
                    });
                }
                md5Expected = stream.headers['content-md5'];
                hash = crypto.createHash('md5');
                stream.on('data', function (chunk) {
                    if (bar)
                        bar.advance(chunk.length);
                    hash.update(chunk);
                });
                outStream = stream.pipe(fs.createWriteStream(outputPath));
            }
            outStream.on(writeStreamFinishEvent, finish);
            outStream.on('error', finish);
            stream.on('error', finish);
            stream.resume();
        });
    });
};
CLI.prototype.do_get_file.description = (
    'Get an image file.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME get-file [OPTIONS] UUID\n' +
    '\n' +
    'Options:\n' +
    '    -o, --output <file>  Write output to <file>\n' +
    /*JSSTYLED*/
    '    -O                   Write output to <UUID-file.EXT> where "EXT" is \n' +
    '                         appropriate for the image file\'s compression\n' +
    '    -q, --quiet          Disable download progress bar.\n'
);
CLI.prototype.do_get_file.longOpts = {
    'output': String,
    'outputUuidExt': Boolean,
    'quiet': Boolean
};
CLI.prototype.do_get_file.shortOpts = {
    'o': ['--output'],
    'O': ['--outputUuidExt'],
    'q': ['--quiet']
};


CLI.prototype.do_get_icon = function do_get_icon(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);
    assert.ok(!(opts.output && opts.outputUuidExt),
        'cannot use both "-o <file>" and "-O" options');

    var outputPath;
    var bar = null;
    var hash = null;
    var md5Expected = null;
    var finished = false;
    function finish(err) {
        if (finished)
            return;
        finished = true;
        if (bar) {
            bar.end();
        }
        if (outputPath) {
            console.error('Saved "%s".', outputPath);
        }
        if (hash && !err) {
            assert.string(md5Expected, 'headers["Content-MD5"]');
            var md5Actual = hash.digest('base64');
            if (md5Actual !== md5Expected) {
                err = new errors.DownloadError(format(
                    'Content-MD5 expected to be %s, but was %s',
                    md5Expected, md5Actual));
            }
        }
        callback(err);
    }

    self.client.getImageIconStream(uuid, function (err, stream) {
        self.log.trace({err: err, res: stream}, 'GetImageIconStream');
        if (opts.output) {
            outputPath = opts.output;
        } else if (opts.outputUuidExt) {
            var ext = {
                'image/jpeg': '.jpg',
                'image/png': '.png',
                'image/gif': '.gif'
            }[stream.headers['content-type']];
            outputPath = format('s-icon%s', uuid, ext);
        }

        if (!outputPath) {
            stream.pipe(process.stdout);
        } else {
            if (!opts.quiet && process.stderr.isTTY) {
                bar = new ProgressBar({
                    size: Number(stream.headers['content-length']),
                    filename: uuid
                });
            }
            md5Expected = stream.headers['content-md5'];
            hash = crypto.createHash('md5');
            stream.on('data', function (chunk) {
                if (bar)
                    bar.advance(chunk.length);
                hash.update(chunk);
            });
            stream.pipe(fs.createWriteStream(outputPath));
        }
        stream.on('end', finish);
        stream.on('error', finish);
    });
};
CLI.prototype.do_get_icon.description = (
    'Get an image icon file.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME get-icon [OPTIONS]\n' +
    '\n' +
    'Options:\n' +
    '    -o, --output <file>  Write output to <file>\n' +
    /*JSSTYLED*/
    '    -O                   Write output to <UUID-icon.EXT> where "EXT" is\n' +
    '                         appropriate for the icon file\'s content type\n' +
    '    -q, --quiet          Disable upload progress bar.\n'
);
CLI.prototype.do_get_icon.longOpts = {
    'output': String,
    'outputUuidExt': Boolean,
    'quiet': Boolean
};
CLI.prototype.do_get_icon.shortOpts = {
    'o': ['--output'],
    'O': ['--outputUuidExt'],
    'q': ['--quiet']
};


CLI.prototype.do_delete = function do_delete(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);
    var delOpts = {};
    if (opts['force-all-channels']) {
        delOpts.forceAllChannels = true;
    }
    this.client.deleteImage(uuid, delOpts, function (err, res) {
        self.log.trace({err: err, res: res}, 'DeleteImage');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        if (!self.features.channels || delOpts.forceAllChannels) {
            console.log('Deleted image %s', uuid);
        } else if (self.client.channel) {
            console.log('Deleted image %s from "%s" channel',
                uuid, self.client.channel);
        } else {
            console.log('Deleted image %s from default channel', uuid);
        }
        callback();
    });
};
CLI.prototype.do_delete.description = (
    'Delete the given image.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME delete UUID\n'
);
/**
 * Changes to the 'delete' command interface if this client uses the
 * 'channels' feature.
 */
CLI.prototype.do_delete._channels_description = (
    'Delete the given image.\n' +
    '\n' +
    'The image is remove from the current channel. When an image is removed\n' +
    'from its last channel, it is deleted from the repository.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME delete UUID\n' +
    '\n' +
    'Options:\n' +
    '    --force-all-channels  Force delete the given image even if it\n' +
    '                          exists in multiple channels.\n'
);
CLI.prototype.do_delete._channels_longOpts = {
    'force-all-channels': Boolean
};



CLI.prototype.do_create = function do_create(subcmd, opts, args, callback) {
    var self = this;
    var rollbackImage = null;
    if (args.length) {
        return callback(new errors.UsageError(
            'unexpected args: ' + args.join(' ')));
    }

    function getManifestData(next) {
        if (opts.manifest) {
            fs.readFile(opts.manifest, 'utf8', next);
        } else if (process.stdin.isTTY) {
            next(new errors.UsageError('image create: no manifest given'));
        } else {
            var data = '';
            var finished = false;
            function finish(err) {
                if (finished)
                    return;
                finished = true;
                next(err, data);
            }
            process.stdin.resume();
            process.stdin.on('data', function (chunk) { data += chunk; });
            process.stdin.on('error', finish);
            process.stdin.on('end', finish);
        }
    }

    /**
     * Rollback the created (but not fully so) image and finish.
     */
    function rollbackOnErr(err) {
        if (err) {
            self.log.debug({err: err, rollbackImage: rollbackImage},
                'rollback partially imported image');
            var delUuid = rollbackImage.uuid;
            self.do_delete('delete', {}, [delUuid], function (delErr) {
                if (delErr) {
                    self.log.debug({err: delErr}, 'error rolling back');
                    console.log('Warning: Could not delete partially ' +
                        'imported image %s: %s', delUuid, delErr);
                }
                callback(err);
            });
        } else {
            callback();
        }
    }

    getManifestData(function (err, data) {
        if (err) {
            return callback(err);
        }
        var manifest;
        try {
            manifest = JSON.parse(data);
        } catch (syntaxErr) {
            return callback(new errors.InvalidManifestDataError(syntaxErr));
        }
        if (!opts.compression && manifest.files && manifest.files[0] &&
            manifest.files[0].compression) {
            opts.compression = manifest.files[0].compression;
        }
        if (!opts.sha1 && manifest.files && manifest.files[0] &&
            manifest.files[0].sha1) {
            opts.sha1 = manifest.files[0].sha1;
        }

        // If we're going to be importing the file as well, make sure we
        // have the requisite info.
        ensureAddFileOpts(opts, function (fErr) {
            if (fErr) {
                return callback(fErr);
            }

            self.client.createImage(manifest, function (cErr, image, res) {
                self.log.trace({err: cErr, image: image, res: res},
                    'CreateImage');
                if (cErr) {
                    return callback(self._errorFromClientError(cErr));
                }
                rollbackImage = image;
                console.log('Imported image %s (%s, %s, state=%s)', image.uuid,
                    image.name, image.version, image.state);
                if (!opts.file) {
                    callback();
                } else {
                    self.do_add_file('add-file', opts, [image.uuid],
                    function (err2) {
                        if (err2) {
                            return rollbackOnErr(err2);
                        }
                        self.do_activate('activate', {}, [image.uuid],
                            rollbackOnErr);
                    });
                }
            });
        });
    });
};
CLI.prototype.do_create.description = (
    'Create an image.\n' +
    '\n' +
    'This creates a new *unactivated* image with the given manifest data.\n' +
    'The typical next steps are to add the image file ($NAME add-file) then\n' +
    'activate the image ($NAME activate). All three steps can be done in\n' +
    'one by specifying the "-f FILE" option.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME create [-m MANIFEST-FILE]\n' +
    '    (manifest data on stdout) | $NAME create\n' +
    '\n' +
    'Options:\n' +
    '    -m MANIFEST-FILE   The manifest file with which to create\n' +
    /*JSSTYLED*/
    '    -f FILE            Also upload the given file and activate the image\n' +
    '    -c COMPRESSION     Specify the compression used for the image\n' +
    '                       file. One of "gzip", "bzip2" or "none". If not\n' +
    '                       given, it is inferred from the file extension.\n' +
    '    -s SHA1            SHA-1 hash of the image file. If given, the\n' +
    '                       server will use it compare it with the uploaded\n' +
    '                       file SHA-1\n' +
    '    --storage          The type of storage preferred for this image\n' +
    '                       file. Can be "local" or "manta". Will try to\n' +
    '                       default to "manta" when available, otherwise\n' +
    '                       "local". This flag will only be relevant if the\n' +
    '                       -f option is passed.\n' +
    '    -q, --quiet        Disable upload progress bar.\n'
);
CLI.prototype.do_create.longOpts = {
    'manifest': String,
    'file': String,
    'compression': String,
    'sha1': String,
    'quiet': Boolean,
    'storage': String
};
CLI.prototype.do_create.shortOpts = {
    'm': ['--manifest'],
    'f': ['--file'],
    'c': ['--compression'],
    's': ['--sha1'],
    'q': ['--quiet']
};


/**
 * Transform an array of 'key=value' CLI arguments to an object.
 *
 * - The use of '.' in the key allows sub-object assignment (only one level
 *   deep).
 * - An attempt will be made the `JSON.parse` a given value, such that
 *   booleans, numbers, objects, arrays can be specified; at the expense
 *   of not being able to specify, e.g., a literal 'true' string.
 * - An empty 'value' is transformed to `null`. Note that 'null' also
 *   JSON.parse's as `null`.
 *
 * Example:
 *  > objFromKeyValueArgs(['nm=foo', 'tag.blah=true', 'empty=', 'nada=null']);
 *  { nm: 'foo',
 *    tag: { blah: true },
 *    empty: null,
 *    nada: null }
 */
function objFromKeyValueArgs(args)
{
    assert.arrayOfString(args, 'args');

    var obj = {};
    args.forEach(function (arg) {
        var kv = strsplit(arg, '=', 2);
        if (kv.length < 2) {
            throw new TypeError(format('invalid key=value argument: "%s"'));
        }

        var v = kv[1];
        if (v === '') {
            v = null;
        } else {
            try {
                v = JSON.parse(v);
            } catch (e) {
                /* pass */
            }
        }

        var k = kv[0];
        var dotted = strsplit(k, '.', 2);
        if (dotted.length > 1) {
            if (!obj[dotted[0]]) {
                obj[dotted[0]] = {};
            }
            obj[dotted[0]][dotted[1]] = v;
        } else {
            obj[k] = v;
        }
    });

    return obj;
}

/*
 * When passing object values such as requirements, we can to merge the
 * values provided into the existing ones
 */
function mergeImageAttributes(body, image) {
    Object.keys(body).forEach(function (key) {
        if (typeof (body[key]) === 'object' &&
            body[key] !== null &&
            image[key] !== undefined)
        {
            var orig = image[key];

            Object.keys(body[key]).forEach(function (bkey) {
                if (body[key][bkey] === null) {
                    delete orig[bkey];
                } else {
                    orig[bkey] = body[key][bkey];
                }
            });
            body[key] = orig;
        }
    });
}

CLI.prototype.do_update = function do_update(subcmd, opts, args, callback) {
    var self = this;
    if (args.length === 0) {
        return callback(new errors.UsageError(
            'expecting image UUID as first argument'));
    }
    if (args.length > 1 && opts.file) {
        return callback(new errors.UsageError(
            'Cannot provide -f|--file and property=value pairs at the same time'
        ));
    }

    var uuid = args[0];
    assertUuid(uuid);

    // When -f or stdin is passed only 1 arg (uuid) is allowed
    // When property=value then n + 1 where n is the number of properties
    var getData = (args.length > 1) ? getArgsData : getFileData;

    function getArgsData(image, next) {
        try {
            args.shift();
            var data = objFromKeyValueArgs(args);
            next(null, data);
        } catch (parseErr) {
            next(parseErr);
        }
    }

    function getFileData(image, next) {
        if (opts.file) {
            fs.readFile(opts.file, 'utf8', next);
        } else if (process.stdin.isTTY) {
            next(new errors.UsageError('image update: no file given'));
        } else {
            var data = '';
            var finished = false;
            function finish(err) {
                if (finished)
                    return;
                finished = true;
                next(err, data);
            }
            process.stdin.resume();
            process.stdin.on('data', function (chunk) { data += chunk; });
            process.stdin.on('error', finish);
            process.stdin.on('end', finish);
        }
    }

    // Make sure image exists first
    self.client.getImage(uuid, function (err, image, res) {
        self.log.trace({err: err, res: res}, 'UpdateImage.GetImage');
        if (err) {
            return callback(self._errorFromClientError(err));
        }

        getData.call(self, image, function (getErr, data) {
            if (getErr) {
                return callback(getErr);
            }

            var body;
            if (typeof (data) === 'string') {
                try {
                    body = JSON.parse(data);
                } catch (syntaxErr) {
                    return callback(
                        new errors.InvalidManifestDataError(syntaxErr));
                }
            } else {
                body = data;
            }

            mergeImageAttributes(body, image);

            self.client.updateImage(uuid, body, function (err2, image2, res2) {
                self.log.trace({err: err2, image: image2, res: res2},
                    'UpdateImage');
                if (err2) {
                    return callback(self._errorFromClientError(err2));
                }
                console.log('Update image %s (%s, %s, state=%s)', image2.uuid,
                    image2.name, image2.version, image2.state);
                callback();
            });
        });
    });
};
CLI.prototype.do_update.description = (
    'Update an image.\n' +
    '\n' +
    'Not every field can be updated. Only the following image attributes\n' +
    'can be modified: description, homepage, public, acl, requirements,\n' +
    'type, os, users, tags, billing_tags, traits, generate_passwords,\n' +
    'nic_driver, disk_driver, cpu_type, image_size and\n' +
    'inherited_directories.\n\n' +
    'Usage:\n' +
    '    $NAME update UUID [-f JSON-FILE]\n' +
    '    $NAME update UUID property=value [property=value ...]\n' +
    '    (json data on stdout) | $NAME update UUID\n' +
    '\n' +
    'Options:\n' +
    '    -f JSON-FILE       JSON file containing the properties/values of\n' +
    '                       the image that needs to be updated\n'
);
CLI.prototype.do_update.longOpts = {
    'file': String
};
CLI.prototype.do_update.shortOpts = {
    'f': ['--file']
};


CLI.prototype.do_import = function do_import(subcmd, opts, args, callback) {
    var self = this;
    var rollbackImage = null;
    var uuid;

    if (args.length > 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    } else if (args.length === 1) {
        // `*-imgadm import -S <source-url> <uuid>`
        uuid = args[0];
        assertUuid(uuid);

        if (!opts['source-url']) {
            return callback(new errors.UsageError('no source URL given'));
        }

        var importOpts = {};
        var source = opts['source-url'];

        if (opts['skip-owner-check']) {
            importOpts.skipOwnerCheck = true;
        }
        self.client.adminImportRemoteImageAndWait(uuid, source, importOpts,
                                function (err, image, res) {
            rollbackImage = image;
            self.log.trace({err: err, image: image, res: res}, 'ImportImage');
            if (err) {
                if (rollbackImage) {
                    return rollbackOnErr(err);
                } else {
                    return callback(self._errorFromClientError(err));
                }
            }
            console.log('Imported image %s (%s, %s, state=%s)', image.uuid,
                image.name, image.version, image.state);
            callback();
        });

        // Make sure we don't run the regular import with manifest
        return;
    }

    // `*-imgadm import -f <file> -m <manifest>`

    function getManifestData(next) {
        if (opts.manifest) {
            fs.readFile(opts.manifest, 'utf8', next);
        } else if (process.stdin.isTTY) {
            next(new errors.UsageError('image import: no manifest given'));
        } else {
            var data = '';
            var finished = false;
            function finish(err) {
                if (finished)
                    return;
                finished = true;
                next(err, data);
            }
            process.stdin.resume();
            process.stdin.on('data', function (chunk) { data += chunk; });
            process.stdin.on('error', finish);
            process.stdin.on('end', finish);
        }
    }

    /**
     * Rollback the created (but not fully so) image and finish.
     */
    function rollbackOnErr(err) {
        if (err) {
            self.log.debug({err: err, rollbackImage: rollbackImage},
                'rollback partially imported image');
            var delUuid = rollbackImage.uuid;
            self.do_delete('delete', {}, [delUuid], function (delErr) {
                if (delErr) {
                    self.log.debug({err: delErr}, 'error rolling back');
                    console.log('Warning: Could not delete partially ' +
                        'imported image %s: %s', delUuid, delErr);
                }
                callback(err);
            });
        } else {
            callback();
        }
    }

    getManifestData(function (err, data) {
        if (err) {
            return callback(err);
        }
        var manifest;
        try {
            manifest = JSON.parse(data);
        } catch (syntaxErr) {
            return callback(new errors.InvalidManifestDataError(syntaxErr));
        }
        if (!opts.compression && manifest.files && manifest.files[0] &&
            manifest.files[0].compression) {
            opts.compression = manifest.files[0].compression;
        }
        if (!opts.sha1 && manifest.files && manifest.files[0] &&
            manifest.files[0].sha1) {
            opts.sha1 = manifest.files[0].sha1;
        }

        // If we're going to be importing the file as well, make sure we
        // have the requisite info.
        ensureAddFileOpts(opts, function (fErr) {
            if (fErr) {
                return callback(fErr);
            }

            var importOpts2 = {};
            if (opts['skip-owner-check']) {
                importOpts2.skipOwnerCheck = true;
            }
            self.client.adminImportImage(manifest, importOpts2,
                                         function (err2, image, res) {
                self.log.trace({err: err2, image: image, res: res},
                    'AdminImportImage');
                if (err2) {
                    return callback(self._errorFromClientError(err2));
                }
                console.log('Imported image %s (%s, %s, state=%s)', image.uuid,
                    image.name, image.version, image.state);
                rollbackImage = image;
                if (!opts.file) {
                    callback();
                } else {
                    self.do_add_file('add-file', opts, [image.uuid],
                    function (err3) {
                        if (err3) {
                            return rollbackOnErr(err3);
                        }
                        self.do_activate('activate', {}, [image.uuid],
                            rollbackOnErr);
                    });
                }
            });
        });
    });
};
CLI.prototype.do_import.description = (
    'Import an image. (Operator-only)\n' +
    '\n' +
    'The import action differs from "$NAME create" in that the "uuid" and\n' +
    '"published_at" fields are preserved. This is an operator-only action\n' +
    'used for transferring images between IMGAPI servers.\n' +
    '\n' +
    'An image may be imported directly from another IMGAPI by using the\n' +
    '"-S" option. In this case the target IMGAPI will handle retrieving the\n' +
    'manifest and image file\n' +
    'A manifest file or a source URL to the origin IMGAPI repository can be\n' +
    'provided. Both cases are explained below.\n' +
    '\n' +
    'Alternatively, a local manifest file may be imported with the "-m"\n' +
    'option or on stdin. The resulting image is *unactivated*. The typical\n' +
    'next steps are to add the image file ($NAME add-file) then activate\n' +
    'the image ($NAME activate). All three steps can be done in one by\n' +
    'specifying the "-f FILE" option.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME import UUID -S SOURCE-URL [OPTIONS]\n' +
    '\n' +
    '    $NAME import -m MANIFEST-FILE [OPTIONS]\n' +
    '    (manifest data on stdout) | $NAME import [OPTIONS]\n' +
    '\n' +
    'Options:\n' +
    '    -S SOURCE-URL      URL of the remote IMGAPI repository source.\n' +
    '                       This is the full URL to the origin IMGAPI\n' +
    '                       without any suffix endpoint or action. Example:\n' +
    '                       https://images.joyent.com. To import from a\n' +
    '                       particular source *channel*, append\n' +
    '                       "?channel=CHANNEL" to the URL.\n' +
    '\n' +
    '    -m MANIFEST-FILE   The manifest file with which to import\n' +
    /*JSSTYLED*/
    '    -f FILE            Also upload the given file and activate the image\n' +
    '    -c COMPRESSION     Specify the compression used for the image\n' +
    '                       file. One of "gzip", "bzip2" or "none". If not\n' +
    '                       given, it is inferred from the file extension.\n' +
    '                       This option is not allowed for *source* URL\n' +
    '                       imports.\n' +
    '    -s SHA1            SHA-1 hash of the image file. If given, the\n' +
    '                       server will use it compare it with the uploaded\n' +
    '                       file SHA-1. This option is not allowed for\n' +
    '                       *source* URL imports.\n' +
    '    --storage          The type of storage preferred for this image\n' +
    '                       file. Can be "local" or "manta". Will try to\n' +
    '                       default to "manta" when available, otherwise\n' +
    '                       "local". This flag will only be relevant if the\n' +
    '                       -f option is passed.\n' +
    '    -q, --quiet        Disable upload progress bar.\n' +
    '\n' +
    '    --skip-owner-check Skip the check that the "owner" UUID exists in\n' +
    '                       the user database. This check is only done for\n' +
    '                       IMGAPI instances inside an SDC. I.e. this\n' +
    '                       option does not apply to images.joyent.com.\n'
);
CLI.prototype.do_import.longOpts = {
    'manifest': String,
    'file': String,
    'compression': String,
    'sha1': String,
    'source-url': String,
    'skip-owner-check': Boolean,
    'quiet': Boolean,
    'storage': String
};
CLI.prototype.do_import.shortOpts = {
    'm': ['--manifest'],
    'f': ['--file'],
    'c': ['--compression'],
    's': ['--sha1'],
    'S': ['--source-url'],
    'q': ['--quiet']
};


CLI.prototype.do_add_file = function do_add_file(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);

    if (!opts.file) {
        return callback(new errors.UsageError('no image file path given'));
    }

    function getFileInfo(next) {
        ensureAddFileOpts(opts, function (fErr) {
            if (fErr)
                return next(fErr);
            fs.stat(opts.file, function (statErr, stats) {
                if (statErr)
                    return next(statErr);
                stats.compression = opts.compression;
                next(null, stats);
            });
        });
    }

    getFileInfo(function (infoErr, info) {
        if (infoErr) {
            return callback(infoErr);
        }

        var stream = fs.createReadStream(opts.file);
        imgapi.pauseStream(stream);

        var bar;
        var sha1Hash = crypto.createHash('sha1');
        if (!opts.quiet && process.stderr.isTTY) {
            bar = new ProgressBar({
                size: info.size,
                filename: uuid
            });
        }
        stream.on('data', function (chunk) {
            if (bar)
                bar.advance(chunk.length);
            sha1Hash.update(chunk);
        });
        stream.on('end', function () {
            if (bar)
                bar.end();
        });

        var fopts = {
            uuid: uuid,
            file: stream,
            size: info.size,
            compression: info.compression
        };
        if (opts.sha1) {
            fopts.sha1 = opts.sha1;
        }
        if (opts.storage) {
            fopts.storage = opts.storage;
        }
        self.client.addImageFile(fopts, function (err, image, res) {
            self.log.trace({err: err, image: image, res: res}, 'AddImageFile');
            if (err) {
                if (bar)
                    bar.end();
                return callback(self._errorFromClientError(err));
            }

            console.log('Added file "%s" (compression "%s") to image %s',
                opts.file, opts.compression, uuid);

            // Verify uploaded size and sha1.
            if (sha1Hash) {
                var expectedSha1 = sha1Hash.digest('hex');
                if (expectedSha1 !== image.files[0].sha1) {
                    return callback(new errors.UploadError(format(
                        'sha1 expected to be %s, but was %s',
                        expectedSha1, image.files[0].sha1)));
                }
            }
            var expectedSize = info.size;
            if (expectedSize !== image.files[0].size) {
                return callback(new errors.UploadError(format(
                    'size expected to be %s, but was %s',
                    expectedSize, image.files[0].size)));
            }

            callback();
        });
    });
};
CLI.prototype.do_add_file.description = (
    'Add an image file.\n' +
    '\n' +
    'Typically this is used to add the image file to a newly created image,\n' +
    '$NAME create. Then use `$NAME activate UUID` to activate the image.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME add-file UUID -f FILE [OPTIONS]\n' +
    '\n' +
    'Options:\n' +
    '    -f FILE            Image file to add\n' +
    '    -c COMPRESSION     Specify the compression used for the image\n' +
    '                       file. One of "gzip", "bzip2" or "none". If not\n' +
    '                       given, it may be inferred from common file\n' +
    '                       extensions.\n' +
    '    -s SHA1            SHA-1 hash of the image file. If given, the\n' +
    '                       server will use it compare it with the uploaded\n' +
    '                       file SHA-1\n' +
    '    --storage          The type of storage preferred for this image\n' +
    '                       file. Can be "local" or "manta". Will try to\n' +
    '                       default to "manta" when available, otherwise\n' +
    '                       "local"\n' +
    '    -q, --quiet        Disable progress bar.\n'
);
CLI.prototype.do_add_file.longOpts = {
    'file': String,
    'compression': String,
    'sha1': String,
    'quiet': Boolean,
    'storage': String
};
CLI.prototype.do_add_file.shortOpts = {
    'f': ['--file'],
    'c': ['--compression'],
    's': ['--sha1'],
    'q': ['--quiet']
};


CLI.prototype.do_add_icon = function do_add_icon(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);

    if (!opts.file) {
        return callback(new errors.UsageError('no icon file path given'));
    }

    function getFileInfo(next) {
        ensureAddIconOpts(opts, function (fErr) {
            if (fErr)
                return next(fErr);
            fs.stat(opts.file, function (statErr, stats) {
                if (statErr)
                    return next(statErr);
                next(null, stats);
            });
        });
    }

    getFileInfo(function (infoErr, info) {
        if (infoErr) {
            return callback(infoErr);
        }

        var stream = fs.createReadStream(opts.file);
        imgapi.pauseStream(stream);

        var bar;
        var sha1Hash = crypto.createHash('sha1');
        if (!opts.quiet && process.stderr.isTTY) {
            bar = new ProgressBar({
                size: info.size,
                filename: uuid
            });
        }
        stream.on('data', function (chunk) {
            if (bar)
                bar.advance(chunk.length);
            sha1Hash.update(chunk);
        });
        stream.on('end', function () {
            if (bar)
                bar.end();
        });

        var fopts = {
            uuid: uuid,
            file: stream,
            size: info.size,
            contentType: opts.contentType
        };
        if (opts.sha1) {
            fopts.sha1 = opts.sha1;
        }
        self.client.addImageIcon(fopts, function (err, image, res) {
            self.log.trace({err: err, image: image, res: res}, 'AddImageIcon');
            if (err) {
                if (bar)
                    bar.end();
                return callback(self._errorFromClientError(err));
            }

            console.log('Added icon "%s" to image %s', opts.file, uuid);
            callback();
        });
    });
};
CLI.prototype.do_add_icon.description = (
    'Add an image icon.\n' +
    '\n' +
    'An optional feature to add an icon file to an image. Icon files must \n' +
    'not be bigger than 128KB and they must be one of the following file \n' +
    'types: .jpg, .png or .gif.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME add-icon UUID -f FILE [OPTIONS]\n' +
    '\n' +
    'Options:\n' +
    '    -f FILE            Image file to add\n' +
    '    -c CONTENT_TYPE    Content type of the icon file. One of\n' +
    '                       "image/jpeg" (or jpg), "image/png" or\n' +
    '                       "image/gif". If not given, it may be inferred\n' +
    '                       from common file extensions.\n' +
    '    -s SHA1            SHA-1 hash of the image icon file. If given,\n' +
    '                       the server will use it compare it with the\n' +
    '                       uploaded file SHA-1\n' +
    '    --storage          The type of storage preferred for this image\n' +
    '                       file. Can be "local" or "manta". Will try to\n' +
    '                       default to "manta" when available, otherwise\n' +
    '                       "local"\n' +
    '    -q, --quiet        Disable progress bar.\n'
);
CLI.prototype.do_add_icon.longOpts = {
    'file': String,
    'contentType': String,
    'sha1': String,
    'quiet': Boolean,
    'storage': String
};
CLI.prototype.do_add_icon.shortOpts = {
    'f': ['--file'],
    'c': ['--contentType'],
    's': ['--sha1'],
    'q': ['--quiet']
};


CLI.prototype.do_delete_icon =
function do_delete_icon(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);

    self.client.deleteImageIcon(uuid, function (err, image, res) {
        self.log.trace({err: err, image: image, res: res}, 'DeleteImageIcon');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        assert.ok(!(image.icon), 'no icon');
        console.log('Deleted icon from image %s', uuid);
        callback();
    });
};
CLI.prototype.do_delete_icon.description = (
    'Delete the image icon.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME delete-icon UUID\n'
);


CLI.prototype.do_export = function do_export(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);

    var mpath = opts['output-template'];
    if (!mpath) {
        return callback(new errors.UsageError('no output Manta path given'));
    }

    var options = { manta_path: mpath };
    self.client.exportImage(uuid, options, function (err, image, res) {
        self.log.trace({err: err, image: image, res: res}, 'ExportImage');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        console.log('Image %s exported to Manta path', uuid, mpath);
        callback();
    });
};
CLI.prototype.do_export.description = (
    /* BEGIN JSSTYLED */
    'Export an image.\n' +
    '\n' +
    'The image manifest and its file are exported to the specified Manta\n' +
    'path. Only images that are stored in manta can be exported.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME export UUID -o MANTA_PATH\n' +
    '\n' +
    'Options:\n' +
    '    -h, --help     Print this help and exit.\n' +
    '    -o MANTA_PATH, --output-template MANTA_PATH\n' +
    '                   Manta path prefix to which to export the image manifest\n' +
    '                   and image file. By default "NAME-VER.imgmanifest\n' +
    '                   and "NAME-VER.zfs[.EXT]" are the filename templates\n' +
    '                   for both files. "MANTA_PATH" must resolve to a directory\n' +
    '                   that is owned by the IMGAPI Manta user in order for the\n' +
    '                   operation to be successful.\n'
    /* END JSSTYLED */
);
CLI.prototype.do_export.longOpts = {
    'output-template': String
};
CLI.prototype.do_export.shortOpts = {
    'o': ['--output-template']
};


CLI.prototype.do_activate = function do_activate(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);

    self.client.activateImage(uuid, function (err, image, res) {
        self.log.trace({err: err, image: image, res: res}, 'ActivateImage');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        console.log('Activated image %s', uuid);
        callback();
    });
};
CLI.prototype.do_activate.description = (
    'Activate an image.\n' +
    '\n' +
    'The final step in making an image available for use is to activate it.\n' +
    'This is typically done after creation ($NAME create) and adding the\n' +
    'image file ($NAME add-file). Once active, an image cannot be \n' +
    'de-activated, only disabled, made private or deleted.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME activate UUID\n'
);


CLI.prototype.do_disable = function do_disable(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);

    self.client.disableImage(uuid, function (err, image, res) {
        self.log.trace({err: err, image: image, res: res}, 'DisableImage');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        assert.equal(image.disabled, true);
        console.log('Disabled image %s', uuid);
        callback();
    });
};
CLI.prototype.do_disable.description = (
    'Disable an image.\n' +
    '\n' +
    'This sets the "disabled" field true and updates the state accordingly\n' +
    'Note that if the image is not yet activated, the state will remain\n' +
    '"unactivated". In SDC a disabled image is not available for\n' +
    'provisioning.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME disable UUID\n'
);


CLI.prototype.do_enable = function do_enable(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);

    self.client.enableImage(uuid, function (err, image, res) {
        self.log.trace({err: err, image: image, res: res}, 'EnableImage');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        assert.equal(image.disabled, false);
        console.log('Enabled image %s (state is now "%s")', uuid, image.state);
        callback();
    });
};
CLI.prototype.do_enable.description = (
    'Enable an image.\n' +
    '\n' +
    'This sets the "disabled" field false and updates the state accordingly\n' +
    'Note that if the image is not yet activated, the state will remain\n' +
    '"unactivated". In SDC a disabled image is not available for\n' +
    'provisioning.\n\n' +
    'Usage:\n' +
    '    $NAME enable UUID\n'
);


CLI.prototype.do_add_acl = function do_add_acl(subcmd, opts, args, callback) {
    var self = this;

    if (args.length === 0) {
        return callback(new errors.UsageError(
            'expecting image UUID as first argument'));
    }
    var uuid = args.shift();
    assertUuid(uuid);

    if (args.length === 0) {
        return callback(new errors.UsageError(
            'expecting at least one account UUID'));
    }
    var acl = args;

    self.client.addImageAcl(uuid, acl, function (err, image, res) {
        self.log.trace({err: err, image: image, res: res}, 'AddImageAcl');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        assert.ok(image.acl);
        console.log('Updated ACL for image %s', uuid);
        callback();
    });
};
CLI.prototype.do_add_acl.description = (
    'Add account UUIDs to the image ACL.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME add-acl UUID acc-uuid1 [ acc-uuid2 [ acc-uuid3 ... ] ]\n'
);


CLI.prototype.do_remove_acl =
function do_remove_acl(subcmd, opts, args, callback) {
    var self = this;

    if (args.length === 0) {
        return callback(new errors.UsageError(
            'expecting image UUID as first argument'));
    }
    var uuid = args.shift();
    assertUuid(uuid);

    if (args.length === 0) {
        return callback(new errors.UsageError(
            'expecting at least one account UUID'));
    }
    var acl = args;

    self.client.removeImageAcl(uuid, acl, function (err, image, res) {
        self.log.trace({err: err, image: image, res: res}, 'RemoveImageAcl');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        console.log('Updated ACL for image %s', uuid);
        callback();
    });
};
CLI.prototype.do_remove_acl.description = (
    'Remove account UUIDs from the image ACL.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME remove-acl UUID acc-uuid1 [ acc-uuid2 [ acc-uuid3 ... ] ]\n'
);


CLI.prototype.do_channels = function do_channels(subcmd, opts, args, cb) {
    var self = this;
    if (args.length !== 0) {
        return cb(new errors.UsageError('too many arguments'));
    }

    self.client.listChannels({}, function (err, channels, res, req) {
        self.log.trace({err: err, channels: channels,
            client_req: req, client_res: res}, 'ListChannels');
        if (err) {
            return cb(self._errorFromClientError(err));
        }
        if (opts.json) {
            console.log(JSON.stringify(channels, null, 2));
        } else {
            var allColumns = ['name', 'default', 'description'];
            tabula(channels, {
                skipHeader: opts.skipHeader,
                /*JSSTYLED*/
                columns: (opts.output ? opts.output.split(/,/g) : allColumns),
                validFields: allColumns
            });
        }
        cb();
    });
};
CLI.prototype.do_channels.description = (
    'List the channels supported by the IMGAPI repository.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME channels\n' +
    '\n' +
    'Options:\n' +
    '    -j, --json         JSON output\n' +
    '    -H                 Do not print table header row\n' +
    '    -o field1,...      Specify fields (columns) to output.\n'
);
CLI.prototype.do_channels.longOpts = {
    'json': Boolean,
    'skipHeader': Boolean,
    'output': String
};
CLI.prototype.do_channels.shortOpts = {
    'j': ['--json'],
    'H': ['--skipHeader'],
    'o': ['--output']
};


CLI.prototype.do_channel_add = function do_channel_add(subcmd, opts, args, cb) {
    var self = this;
    if (args.length === 0) {
        return cb(new errors.UsageError('not enough arguments'));
    }

    var channel = args[0];
    var uuids = args.slice(1);
    var errs = [];
    vasync.forEachParallel({
        inputs: uuids,
        func: function channelAddOne(uuid, next) {
            var chOpts = {
                channel: channel,
                uuid: uuid
            };
            self.client.channelAddImage(chOpts, function (err, img, res, req) {
                self.log.trace({err: err, client_req: req, client_res: res,
                    img: img}, 'ChannelAddImage');
                if (err) {
                    errs.push(self._errorFromClientError(err));
                    console.error('Error adding image %s to "%s" channel',
                        uuid, channel);
                } else {
                    console.log('Added image %s (%s@%s) to "%s" channel',
                        uuid, img.name, img.version, channel);
                }
                next();
            });
        }
    }, function finish(err) {
        if (err) {
            cb(err);
        } else if (errs.length === 1) {
            cb(errs[0]);
        } else if (errs.length > 1) {
            cb(new errors.MultiError(errs));
        } else {
            cb();
        }
    });
};
CLI.prototype.do_channel_add.description = (
    'Add an image (or images) to the given channel.\n'+
    '\n' +
    'Usage:\n' +
    '    $NAME channel-add <channel> [<image> ...]\n' +
    '\n' +
    'Use "$NAME delete ..." to remove an image from a channel.\n'
);



CLI.prototype.do_change_stor = function do_change_stor(subcmd, opts, args, cb) {
    var self = this;
    if (args.length === 0) {
        return cb(new errors.UsageError('not enough arguments'));
    }

    var stor = args[0];
    var uuids = args.slice(1);
    var errs = [];
    // TODO: Really want limit on concurrency here (see
    // https://github.com/davepacheco/node-vasync/issues/27).
    vasync.forEachParallel({
        inputs: uuids,
        func: function changeStorOne(uuid, next) {
            var chOpts = {
                uuid: uuid,
                stor: stor
            };
            self.client.adminChangeStor(chOpts, function (err, img, res, req) {
                self.log.trace({err: err, client_req: req, client_res: res,
                    img: img}, 'AdminChangeImageStor');
                if (err) {
                    errs.push(self._errorFromClientError(err));
                    console.error('Error changing image %s stor to "%s"',
                        uuid, stor);
                } else {
                    console.log('Changed image %s (%s@%s) stor to "%s"',
                        uuid, img.name, img.version, stor);
                }
                next();
            });
        }
    }, function finish(err) {
        if (err) {
            cb(err);
        } else if (errs.length === 1) {
            cb(errs[0]);
        } else if (errs.length > 1) {
            cb(new errors.MultiError(errs));
        } else {
            cb();
        }
    });
};
CLI.prototype.do_change_stor.description = (
    'Change the backing storage for the given images\' files.\n' +
    'This is intended for operators-only.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME change-stor <stor> [<image> ...]\n'
);



//---- exports

module.exports = CLI;
