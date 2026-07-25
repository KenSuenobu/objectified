/* File-stat program whose program block lacks its numeric assignment. */
enum file_kind {
    FILE_REGULAR = 0,
    FILE_DIRECTORY = 1
};

struct file_stat_args {
    string path<256>;
};

struct file_stat_res {
    file_kind kind;
    hyper size;
};

program FILE_PROG {
    version FILE_VERS {
        file_stat_res FILE_STAT(file_stat_args) = 1;
    } = 1;
};
