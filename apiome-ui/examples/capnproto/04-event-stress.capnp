# Cap'n Proto schema example — stress: an unnamed union, a group, nested
# enums and structs, Data / AnyPointer / nested List types, a constant, and a
# multi-method capability.
@0xe59b7c31a8d40f26;

const maxBatch :UInt16 = 512;

struct Event {
  id @0 :UInt64;
  payload @1 :Data;
  matrix @2 :List(List(Float64));
  tags @3 :List(Text);
  severity @4 :Severity;

  enum Severity {
    debug @0;
    info @1;
    warning @2;
    error @3;
  }

  union {
    created @5 :Created;
    deleted @6 :Deleted;
    note @7 :Text;
  }

  struct Created {
    actor @0 :Text;
  }

  struct Deleted {
    reason @0 :Text;
  }

  location :group {
    latitude @8 :Float64;
    longitude @9 :Float64;
  }
}

struct Batch {
  events @0 :List(Event);
  next @1 :AnyPointer;
}

interface Collector {
  publish @0 (batch :Batch) -> (accepted :UInt32);
  drain @1 (queue :Text) -> (events :List(Event));
  ping @2 () -> ();
}
