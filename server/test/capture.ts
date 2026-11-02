/** Record what the server writes to a pi process for one request; `stop()` restores its write. */
export function captureWrites(proc: { write: (rec: any) => unknown }, reqId: string) {
  const writes: any[] = [];
  const write = proc.write.bind(proc);
  proc.write = (rec: any) => {
    if (rec.id === reqId) writes.push(rec);
    return write(rec);
  };
  return { writes, stop: () => (proc.write = write) };
}
