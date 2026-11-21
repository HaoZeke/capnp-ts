/* Send and receive one byte buffer plus SCM_RIGHTS file descriptors. */
#include <errno.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int capnp_send_fds(int sock, const void *buf, int len, const int *fds, int nfds) {
  struct iovec iov;
  struct msghdr msg;
  char control[CMSG_SPACE(sizeof(int) * 253)];
  memset(&msg, 0, sizeof(msg));
  iov.iov_base = (void *)buf;
  iov.iov_len = (size_t)len;
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  if (nfds > 0) {
    struct cmsghdr *cmsg;
    if (nfds > 253) nfds = 253;
    msg.msg_control = control;
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
  char control[CMSG_SPACE(sizeof(int) * 253)];
  struct cmsghdr *cmsg;
  int n;
  memset(&msg, 0, sizeof(msg));
  iov.iov_base = buf;
  iov.iov_len = (size_t)cap;
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = control;
  msg.msg_controllen = sizeof(control);
  *nfds = 0;
  n = (int)recvmsg(sock, &msg, 0);
  if (n < 0) return n;
  for (cmsg = CMSG_FIRSTHDR(&msg); cmsg != 0; cmsg = CMSG_NXTHDR(&msg, cmsg)) {
    int count;
    if (cmsg->cmsg_level != SOL_SOCKET || cmsg->cmsg_type != SCM_RIGHTS) continue;
    count = (int)((cmsg->cmsg_len - CMSG_LEN(0)) / sizeof(int));
    if (count > maxfds) count = maxfds;
    if (count > 0) {
      memcpy(fds, CMSG_DATA(cmsg), sizeof(int) * (size_t)count);
      *nfds = count;
    }
  }
  (void)errno;
  return n;
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
