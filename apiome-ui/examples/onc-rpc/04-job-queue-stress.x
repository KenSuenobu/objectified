/*
 * ONC RPC / XDR example — stress rung: less common RPCL corners in one file.
 *
 * Two versions inside one program (the RPCL versioning grammar), a union with
 * several case arms and a populated default arm, bounded opaque and string
 * payloads, `unsigned hyper` and `bool` scalars, and a void procedure.
 */

enum job_state {
    JOB_QUEUED = 0,
    JOB_RUNNING = 1,
    JOB_DONE = 2,
    JOB_FAILED = 3
};

typedef string job_id<36>;

struct job_spec {
    job_id id;
    string command<512>;
    unsigned hyper submitted_at;
    bool urgent;
};

struct job_error {
    int code;
    string detail<256>;
};

union job_status_res switch (job_state state) {
case JOB_QUEUED:
    unsigned int queue_position;
case JOB_RUNNING:
    unsigned int percent_complete;
case JOB_DONE:
    opaque result<4096>;
default:
    job_error error;
};

program JOB_PROG {
    version JOB_VERS_1 {
        job_state JOB_SUBMIT(job_spec) = 1;
        job_status_res JOB_STATUS(job_id) = 2;
    } = 1;
    version JOB_VERS_2 {
        job_state JOB_SUBMIT2(job_spec) = 1;
        job_status_res JOB_STATUS2(job_id) = 2;
        void JOB_CANCEL(job_id) = 3;
    } = 2;
} = 0x20000004;
