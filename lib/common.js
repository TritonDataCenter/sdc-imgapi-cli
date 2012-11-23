/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Dump for shared imgapi-cli stuff that doesn't fit in another source file.
 */


function getVersion() {
    return require('../package.json').version;
}



//---- exports

module.exports = {
    getVersion: getVersion
};
