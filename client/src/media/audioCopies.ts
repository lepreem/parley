/**
 * The audio of the sources uploaded from this browser, kept in IndexedDB by
 * audio upload id. The cloud removes a source's audio a week after it's
 * transcribed, so this copy is what plays it after that. Clearing the site's
 * data clears it; picking the original file again restores it.
 *
 * Where storage is blocked (private browsing, say) load reads as nothing
 * stored, and save and remove reject for their callers to shrug off: playback
 * has other ways to get the audio.
 */

const DB_NAME = "parley-audio";
const STORE = "audio";

let opened: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error: unknown) => {
    // Let a later call try again rather than keep the failure for good.
    opened = null;
    throw error;
  });
  return opened;
}

async function inStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

let persistAsked = false;

/** Keeps a source's audio, replacing any copy it had. */
async function save(audioUploadId: string, audio: Blob): Promise<void> {
  // Without this the browser may evict the copies when the disk runs low.
  if (!persistAsked) {
    persistAsked = true;
    void navigator.storage?.persist?.().catch(() => false);
  }
  await inStore("readwrite", (store) => store.put(audio, audioUploadId));
}

/** The source's audio, or null when this browser has no copy. */
async function load(audioUploadId: string): Promise<Blob | null> {
  try {
    const audio = await inStore<unknown>("readonly", (store) =>
      store.get(audioUploadId),
    );
    return audio instanceof Blob ? audio : null;
  } catch {
    return null;
  }
}

async function remove(audioUploadId: string): Promise<void> {
  await inStore("readwrite", (store) => store.delete(audioUploadId));
}

export const audioCopies = { save, load, remove };
