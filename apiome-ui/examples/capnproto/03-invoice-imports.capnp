# Cap'n Proto schema example — composition: import aliases plus nested type reuse.
#
# `using Shared = import "shared.capnp"` binds a sibling schema file; further
# `using` lines create local aliases for its nested types, and fields below
# reference those aliases. `Invoice.Line` shows a nested struct reused via its
# parent scope.
@0xa41c2b9d5f36e708;

using Shared = import "shared.capnp";
using Money = Shared.Money;
using Party = Shared.Party;

struct Invoice {
  id @0 :Text;
  issuer @1 :Party;
  total @2 :Money;
  lines @3 :List(Line);

  struct Line {
    sku @0 :Text;
    quantity @1 :UInt32;
    unitPrice @2 :Money;
  }
}

interface Billing {
  issue @0 (invoice :Invoice) -> (id :Text);
  lookup @1 (id :Text) -> (invoice :Invoice);
}
