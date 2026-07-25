# Cap'n Proto schema example — minimal document.
#
# The smallest canonical .capnp file: the mandatory 64-bit file id plus a
# single struct with one field.
@0xd3a1f5c8e7b2a904;

struct Ping {
  message @0 :Text;
}
