/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * The main entry point for an imgapi-cli instance.
 */



//---- CLI object

function CLI() {

}

CLI.prototype.main = function main(argv) {
    console.log("imgapi-cli CLI.main:", argv);
}



//---- exports

module.exports = CLI;
