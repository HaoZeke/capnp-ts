/* Send and receive one byte buffer plus SCM_RIGHTS file descriptors. */
#include <errno.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int capnp_send_fds(int sock, const void *buf, int len, const int *fds, int nfds) {
  struct iovec iov;
  struct msghdr msg;
  union {
    char buf[CMSG_SPACE(sizeof(int) * 253)];
    struct cmsghdr align;
  } control;
  memset(&msg, 0, sizeof(msg));
  iov.iov_base = (void *)buf;
  iov.iov_len = (size_t)len;
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  if (nfds > 0) {
    struct cmsghdr *cmsg;
    /* The vat refuses this before it writes attachedFd indices. Truncating
       here would send a short list and leave those indices out of range. */
    if (nfds > 253) return -1;
    msg.msg_control = control.buf;
    msg.msg_controllen = CMSG_SPACE(sizeof(int) * (size_t)nfds);
    cmsg = CMSG_FIRSTHDR(&msg);
    cmsg->cmsg_level = SOL_SOCKET;
    cmsg->cmsg_type = SCM_RIGHTS;
    cmsg->cmsg_len = CMSG_LEN(sizeof(int) * (size_t)nfds);
    memcpy(CMSG_DATA(cmsg), fds, sizeof(int) * (size_t)nfds);
  }
  return (int)sendmsg(sock, &msg, 0);
}

int capnp_recv_fds(int sock, void *buf, int cap, int *fds, int maxfds, int *nfds) {
  struct iovec iov;
  struct msghdr msg;
  union {
    char buf[CMSG_SPACE(sizeof(int) * 253)];
    struct cmsghdr align;
  } control;
  struct cmsghdr *cmsg;
  int n;
  int got = 0;
  memset(&msg, 0, sizeof(msg));
  iov.iov_base = buf;
  iov.iov_len = (size_t)cap;
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = control.buf;
  msg.msg_controllen = sizeof(control.buf);
  for (;;) {
    *nfds = 0;
    n = (int)recvmsg(sock, &msg, MSG_CMSG_CLOEXEC);
    if (n < 0 && errno == EINTR) continue;
    break;
  }
  if (n < 0) {
    *nfds = errno;
    if (errno == EAGAIN || errno == EWOULDBLOCK) return -1;
    return -2;
  }
  for (cmsg = CMSG_FIRSTHDR(&msg); cmsg != 0; cmsg = CMSG_NXTHDR(&msg, cmsg)) {
    int count;
    int i;
    int *raw;
    if (cmsg->cmsg_level != SOL_SOCKET || cmsg->cmsg_type != SCM_RIGHTS) continue;
    count = (int)((cmsg->cmsg_len - CMSG_LEN(0)) / sizeof(int));
    raw = (int *)CMSG_DATA(cmsg);
    for (i = 0; i < count; i++) {
      if (got < maxfds) fds[got++] = raw[i];
      else close(raw[i]);
    }
  }
  *nfds = got;
  return n;
}

/* Two SCM_RIGHTS headers in one send, so a receiver can be checked for appending. */
int capnp_send_two(int sock, const void *buf, int len, int fd0, int fd1) {
  struct iovec iov;
  struct msghdr msg;
  union {
    char buf[CMSG_SPACE(sizeof(int)) + CMSG_SPACE(sizeof(int))];
    struct cmsghdr align;
  } control;
  struct cmsghdr *cmsg;
  int one;
  memset(&msg, 0, sizeof(msg));
  memset(&control, 0, sizeof(control));
  iov.iov_base = (void *)buf;
  iov.iov_len = (size_t)len;
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = control.buf;
  msg.msg_controllen = sizeof(control.buf);
  cmsg = CMSG_FIRSTHDR(&msg);
  cmsg->cmsg_level = SOL_SOCKET;
  cmsg->cmsg_type = SCM_RIGHTS;
  cmsg->cmsg_len = CMSG_LEN(sizeof(int));
  one = fd0;
  memcpy(CMSG_DATA(cmsg), &one, sizeof(one));
  cmsg = CMSG_NXTHDR(&msg, cmsg);
  if (cmsg == 0) return -1;
  cmsg->cmsg_level = SOL_SOCKET;
  cmsg->cmsg_type = SCM_RIGHTS;
  cmsg->cmsg_len = CMSG_LEN(sizeof(int));
  one = fd1;
  memcpy(CMSG_DATA(cmsg), &one, sizeof(one));
  return (int)sendmsg(sock, &msg, 0);
}

int capnp_unix_connect(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un addr;
  if (fd < 0) return -1;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
  if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
    close(fd);
    return -1;
  }
  return fd;
}
