const deletedRowsByTable = new Map<string, number>();

export function recordRetentionRowsDeleted(
   tableName: string,
   count: number
): void {
   if (count <= 0) return;
   deletedRowsByTable.set(
      tableName,
      (deletedRowsByTable.get(tableName) ?? 0) + count
   );
}

export function getRetentionMetrics(): Array<{
   table: string;
   value: number;
}> {
   return [...deletedRowsByTable.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, value]) => ({ table, value }));
}

export function resetRetentionMetrics(): void {
   deletedRowsByTable.clear();
}
