// Serves one capability on a unix socket with an attached pipe.
// The pipe's read end is the capability FD and already holds one byte, 'Q'.
#include <capnp/ez-rpc.h>
#include <capnp/message.h>
#include <capnp/rpc-twoparty.h>
#include <kj/async-io.h>
#include <kj/debug.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <cstring>
#include <iostream>

#include "fdcap.capnp.h"

namespace {

class FdCapImpl final : public FdCap::Server {
 public:
  explicit FdCapImpl(kj::AutoCloseFd fd) : fd(kj::mv(fd)) {}
  kj::Maybe<int> getFd() override { return fd.get(); }

 private:
  kj::AutoCloseFd fd;
};

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: fd_peer <unix-path>\n";
    return 2;
  }
  int pipes[2];
  KJ_SYSCALL(pipe(pipes));
  char byte = 'Q';
  KJ_SYSCALL(write(pipes[1], &byte, 1));
  close(pipes[1]);

  int listenFd = socket(AF_UNIX, SOCK_STREAM, 0);
  KJ_REQUIRE(listenFd >= 0);
  unlink(argv[1]);
  sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, argv[1], sizeof(addr.sun_path) - 1);
  KJ_SYSCALL(bind(listenFd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)));
  KJ_SYSCALL(listen(listenFd, 1));
  std::cout << "ready\n" << std::flush;

  int conn = accept(listenFd, nullptr, nullptr);
  KJ_REQUIRE(conn >= 0);
  close(listenFd);

  auto io = kj::setupAsyncIo();
  auto stream = io.lowLevelProvider->wrapUnixSocketFd(conn);
  capnp::TwoPartyClient server(
      *stream, 16, kj::heap<FdCapImpl>(kj::AutoCloseFd(pipes[0])), capnp::rpc::twoparty::Side::SERVER);
  server.onDisconnect().wait(io.waitScope);
  return 0;
}
