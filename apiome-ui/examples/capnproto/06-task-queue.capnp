# Cap'n Proto schema example — a typical task-queue service.
#
# Structs model tasks and their lease lifecycle; the capability interface
# exposes enqueue / claim / complete operations.
@0xb7e2d4f9a1c8e365;

enum TaskState {
  pending @0;
  claimed @1;
  done @2;
  failed @3;
}

struct Task {
  id @0 :UInt64;
  queue @1 :Text;
  payload @2 :Data;
  state @3 :TaskState;
  attempts @4 :UInt8;
  notBefore @5 :Int64;
}

struct Claim {
  task @0 :Task;
  leaseSeconds @1 :UInt32;
}

interface TaskQueue {
  enqueue @0 (task :Task) -> (id :UInt64);
  claim @1 (queue :Text) -> (claim :Claim);
  complete @2 (id :UInt64) -> (state :TaskState);
}
