/*
 * ONC RPC / XDR example — a simple file-stat program.
 */
enum file_kind {
    FILE_REGULAR = 0,
    FILE_DIRECTORY = 1
};

struct file_stat_args {
    string path<256>;
};

struct file_stat_res {
    f