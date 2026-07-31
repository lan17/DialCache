const REDIS_CLUSTER_SLOT_COUNT = 16_384;
const CRC16_XMODEM_POLYNOMIAL = 0x1021;

/** Returns the Redis Cluster hash slot for a UTF-8 string key. */
export function redisClusterSlot(key: string): number {
  return crc16Xmodem(Buffer.from(redisHashInput(key), "utf8")) % REDIS_CLUSTER_SLOT_COUNT;
}

export function groupByRedisClusterSlot<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): Map<number, T[]> {
  const groups = new Map<number, T[]>();

  for (const item of items) {
    const slot = redisClusterSlot(keyOf(item));
    const group = groups.get(slot);
    if (group === undefined) {
      groups.set(slot, [item]);
    } else {
      group.push(item);
    }
  }

  return groups;
}

function redisHashInput(key: string): string {
  const tagStart = key.indexOf("{");
  if (tagStart === -1) {
    return key;
  }

  const tagEnd = key.indexOf("}", tagStart + 1);
  if (tagEnd === -1 || tagEnd === tagStart + 1) {
    return key;
  }

  return key.slice(tagStart + 1, tagEnd);
}

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;

  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) === 0
        ? crc << 1
        : (crc << 1) ^ CRC16_XMODEM_POLYNOMIAL;
      crc &= 0xffff;
    }
  }

  return crc;
}
