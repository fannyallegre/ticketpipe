/** Windows tar stores DOS permissions; mark bundle entries as Unix in the ZIP directory. */
export async function fixMacArchivePermissions(path: string) {
  const data = Buffer.from(await Bun.file(path).arrayBuffer());
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || data.readUInt32LE(end) !== 0x06054b50) throw new Error("Invalid ZIP archive");
  const count = data.readUInt16LE(end + 10);
  let cursor = data.readUInt32LE(end + 16);
  if (count === 0xffff || cursor === 0xffffffff) throw new Error("ZIP64 bundles require a Unix zip tool");
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP directory");
    const nameLength = data.readUInt16LE(cursor + 28), extraLength = data.readUInt16LE(cursor + 30), commentLength = data.readUInt16LE(cursor + 32);
    const name = data.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    const directory = name.endsWith("/");
    const mode = directory ? 0o40755 : name.endsWith("/MacOS/ticketpipe") || name.endsWith("/Helpers/ticketpipe-controller") ? 0o100755 : 0o100644;
    data.writeUInt16LE((3 << 8) | 20, cursor + 4);
    data.writeUInt32LE(((mode << 16) | (directory ? 0x10 : 0)) >>> 0, cursor + 38);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  await Bun.write(path, data);
}
