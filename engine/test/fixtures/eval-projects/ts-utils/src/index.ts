export function reverseString(s: string): string {
  return s.split("").reverse().join("");
}

export function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ((...args: any[]) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  }) as T;
}

export function formatDateA(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function formatDateB(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}`;
}
