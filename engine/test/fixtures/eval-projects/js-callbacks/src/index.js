export async function fetchData(url: string, callback: (err: Error | null, data: string | null) => void): Promise<void> {
  try {
    const response = await fetch(url);
    const text = await response.text();
    callback(null, text);
  } catch (err) {
    callback(err as Error, null);
  }
}

export function retry<T>(fn: () => Promise<T>, attempts: number, callback: (err: Error | null, result: T | null) => void): void {
  fn().then((result) => callback(null, result)).catch((err) => {
    if (attempts > 1) {
      retry(fn, attempts - 1, callback);
    } else {
      callback(err as Error, null);
    }
  });
}
