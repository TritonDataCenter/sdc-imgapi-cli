# sdc-imgapi-cli

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md)
and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

This repository provides a number of CLIs interacting with a Triton
[IMGAPI](https://github.com/joyent/sdc-imgapi) instance. There are typically
three IMGAPI instances with which we interact:

1. <https://images.joyent.com> The central repository of Joyent-vetted images
   for using in Triton DataCenters and SmartOS machines. The `joyent-imgadm`
   tool is made for this.
2. <https://updates.joyent.com> The repository of Joyent-provided images for
   updating components of Triton DataCenter itself. The `updates-imgadm` tool
   is made for this.
3. The IMGAPI service running inside a Triton DataCenter on the (private)
   "admin" network for operators of that DC. The `sdc-imgadm` tool is made for
   this.

All the `*-imgadm` tools are similar, differing only in basic config such as
which endpoint URL, where to gather config, whether the IMGAPI uses auth
(#1 and #2 do, #3 does not), etc. `updates-imgadm` and `joyent-imgadm` can
be used from any machine (i.e. they do not have to be run from a Triton DC
headnode global zone). `sdc-imgadm` is typically just for running in a Triton DC
headnode global or 'sdc0' zone. There is also a general `imgapi-cli` command
that can be used for other IMGAPI endpoints, or for development and testing.

Note that these `*-imgadm` tools are distinct from
[imgadm(1m)](https://smartos.org/man/1m/imgadm). `imgadm` is part of SmartOS
itself and manages Triton images in a SmartOS server's zpool. It imports images
from IMGAPI repositories (such as the 3 listed above).


# Installation

The `*-imgadm` tools can be installed like so:

    npm install -g git+https://github.com/joyent/sdc-imgapi-cli.git

If you are a Triton DC operator these tools will already be setup for use
in the headnode GZ and the headnode 'sdc0' zone.


# Development

Typically sdc-imgapi-cli development on a local Triton COAL instance is done by:

- making edits to a clone of sdc-imgapi-cli.git on your dev machine (e.g.
  a Mac, Linux, or a SmartOS dev zone):

        git clone https://github.com/joyent/sdc-imgapi-cli.git
        cd sdc-imgapi-cli
        git submodule update --init   # not necessary first time
        vi

- building:

        make all
        make check

- syncing changes to your running Triton DC (typically a COAL running locally in
  VMWare) via:

        ./tools/rsync-to coal

- then testing changes in that Triton DC (e.g. COAL) by using the sdc-imgadm
  tool. For example, if changes are made to the `list` command then they can
  immediately be observed by running the following command in the SDC headnode:

        sdc-imgadm list
