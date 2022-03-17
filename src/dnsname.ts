// Adapted from https://github.com/petejkim/ens-dnsname/blob/master/dnsname.go#L59
export function encode(name: string): Buffer {
  const trimmed = name.replace(/^\.+|\.+$/g, "");

  // split name into labels
  const labels = trimmed.split(".").map((l) => Buffer.from(l, "utf8"));

  const encoded = Buffer.alloc(Buffer.from(trimmed, "utf8").byteLength + 2);
  let offset = 0;

  for (const label of labels) {
    const l = label.byteLength;

    // length must be less than 64
    if (l > 63) {
      throw new Error("label too long");
    }

    // write length
    encoded.writeUInt8(l, offset);
    offset++;

    // write label
    label.copy(encoded, offset);
    offset += l;
  }

  return encoded;
}
