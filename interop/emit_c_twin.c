/* Offline twin golden: same schema/alloc order as capnp-fortran interop/golden_master.c */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "capnp_c.h"

#define VAL_ROOT 42u
#define VAL_E0 100u
#define VAL_E1 200u
#define NAME "hi"

int main(void) {
  struct capn c;
  capn_ptr root, rs, lst, e0, e1;
  capn_text t;
  uint8_t buf[512];
  int64_t n;

  capn_init_malloc(&c);
  root = capn_root(&c);

  rs = capn_new_struct(root.seg, 8, 2); /* datasz bytes=8, ptrs=2 */
  capn_write32(rs, 0, VAL_ROOT);

  memset(&t, 0, sizeof t);
  t.str = NAME;
  t.len = (int)strlen(NAME);
  capn_set_text(rs, 0, t);

  /* len 2, datasz 8, ptrs 1 -> composite (spare pointer gate) */
  lst = capn_new_list(root.seg, 2, 8, 1);
  e0 = capn_getp(lst, 0, 0);
  capn_write32(e0, 0, VAL_E0);
  e1 = capn_getp(lst, 1, 0);
  capn_write32(e1, 0, VAL_E1);

  capn_setp(rs, 1, lst);
  capn_setp(root, 0, rs);

  n = capn_write_mem(&c, buf, sizeof buf, 0);
  capn_free(&c);
  if (n <= 0) {
    fprintf(stderr, "capn_write_mem failed: %lld\n", (long long)n);
    return 1;
  }
  if (fwrite(buf, 1, (size_t)n, stdout) != (size_t)n) return 2;
  fprintf(stderr, "wrote %lld framed bytes\n", (long long)n);
  return 0;
}
