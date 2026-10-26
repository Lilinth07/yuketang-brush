#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
    if (argc < 3) return 64;
    if (getpgrp() != getpid() && setpgid(0, 0) != 0) { perror("setpgid"); return 71; }
    execv(argv[1], &argv[1]);
    perror("execv");
    return 71;
}
