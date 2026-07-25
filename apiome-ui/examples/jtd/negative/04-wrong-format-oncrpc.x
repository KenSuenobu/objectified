/* ONC RPC / XDR key-value protocol definition. */
enum kv_status {
    KV_OK = 0,
    KV_NOTFOUND = 1
};

struct kv_pair {
    string key<64>;
    string value<1024>;
};

program KV_PROG {
    version KV_VERS {
        kv_pair KV_GET(string) = 1;
    } = 1;
} = 0x20000101;
