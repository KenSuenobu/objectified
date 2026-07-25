/*
 * ONC RPC / XDR example — a typical metrics-collector service: counters and
 * gauges reported by hosts, queried by name, with a bounded list result.
 */
enum metric_kind {
    METRIC_COUNTER = 0,
    METRIC_GAUGE = 1
};

struct metric_sample {
    string name<128>;
    metric_kind kind;
    hyper value;
    unsigned int timestamp;
};

struct report_args {
    string hostname<64>;
    metric_sample samples<32>;
};

struct report_res {
    unsigned int accepted;
    unsigned int rejected;
};

struct query_args {
    string hostname<64>;
    string name_prefix<128>;
};

struct query_res {
    metric_sample matches<64>;
};

program METRICS_PROG {
    version METRICS_VERS {
        report_res METRICS_REPORT(report_args) = 1;
        query_res METRICS_QUERY(query_args) = 2;
    } = 1;
} = 0x20000101;
