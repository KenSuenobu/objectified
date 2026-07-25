/*
 * ONC RPC / XDR example — composition rung: shared typedefs, enums, and
 * nested structs reused across the document.
 *
 * The `sku` typedef is reused by structs, a union, and procedure signatures;
 * `inv_location` is nested inside `inv_item`, which the union arm reuses in
 * turn — XDR's composition mechanisms (typedef reuse and struct nesting).
 */

typedef string sku<64>;

enum inv_status {
    INV_OK = 0,
    INV_NOT_FOUND = 1,
    INV_ERROR = 2
};

struct inv_location {
    string warehouse<32>;
    unsigned int shelf;
};

struct inv_item {
    sku code;
    unsigned int quantity;
    inv_location location;
};

union inv_lookup_res switch (inv_status status) {
case INV_OK:
    inv_item item;
default:
    void;
};

struct inv_adjust_args {
    sku code;
    int delta;
};

program INV_PROG {
    version INV_VERS {
        inv_lookup_res INV_LOOKUP(sku) = 1;
        inv_status INV_ADJUST(inv_adjust_args) = 2;
    } = 1;
} = 0x20000003;
