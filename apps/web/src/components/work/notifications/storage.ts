// IndexedDB's read/write transaction makes claiming delivery atomic across tabs.
// Only event IDs and expiry are retained; no conversation contents are stored.
async function openReceipts(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("lori-work-notifications", 1);
    let abandoned = false;
    const fail = (message: string) => { abandoned = true; clearTimeout(timer); reject(new Error(message)); };
    const timer = setTimeout(() => fail("Browser storage timed out. Close older Lori tabs and try again."), 10000);
    request.onupgradeneeded = () => request.result.createObjectStore("receipts").createIndex("created", "at");
    request.onsuccess = () => { clearTimeout(timer); if (abandoned) request.result.close(); else resolve(request.result); };
    request.onerror = () => fail("Browser storage is unavailable. Notifications are paused.");
    request.onblocked = () => fail("Close older Lori tabs and try again.");
  });
}

export async function claimNotification(scope: string, id: string, now = Date.now()): Promise<boolean> {
  const db = await openReceipts();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction("receipts", "readwrite"), store = tx.objectStore("receipts");
      let claimed = false;
      const read = store.get([scope, id]);
      read.onsuccess = () => { if (!read.result) { store.put({ at: now }, [scope, id]); claimed = true; } };
      const cursor = store.index("created").openCursor(IDBKeyRange.upperBound(now - 25 * 60 * 60 * 1000));
      cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } };
      tx.oncomplete = () => resolve(claimed);
      tx.onerror = tx.onabort = () => reject(new Error("Browser storage is unavailable. Notifications are paused."));
    });
  } finally { db.close(); }
}

// A rejected browser delivery must remain eligible for the next scan. Only the
// tab that won the atomic claim releases it; successfully delivered or
// deliberately suppressed events retain their receipts.
export async function releaseNotification(scope: string, id: string): Promise<void> {
  const db = await openReceipts();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("receipts", "readwrite");
      tx.objectStore("receipts").delete([scope, id]);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error("Browser storage is unavailable. Notifications are paused."));
    });
  } finally { db.close(); }
}
