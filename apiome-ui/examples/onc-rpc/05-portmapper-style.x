/*
 * ONC RPC / XDR example — real-world rung: a hand-authored reconstruction of
 * the shape of the ONC RPC portmapper protocol (PMAP version 2, RFC 1833).
 * No third-party text is copied; the `mapping` struct and the null / set /
 * unset / getport / callit procedure shapes follow the published protocol.
 */

struct mapping {
    unsigned int prog;
    unsigned int vers;
    unsigned int prot;
    unsigned int port;
};

struct call_args {
    unsigned int prog;
    unsigned int vers;
    unsigned int proc;
    opaque args<2048>;
};

struct call_result {
    unsigned int port;
    opaque res<2048>;
};

program PMAP_PROG {
    version PMAP_VERS {
        void PMAPPROC_NULL(void) = 0;
        bool PMAPPROC_SET(mapping) = 1;
        bool PMAPPROC_UNSET(mapping) = 2;
        unsigned int PMAPPROC_GETPORT(mapping) = 3;
        call_result PMAPPROC_CALLIT(call_args) = 5;
    } = 2;
} = 100000;
