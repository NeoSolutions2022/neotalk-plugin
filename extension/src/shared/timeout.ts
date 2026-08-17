/**
 * Aplica um limite de tempo a uma Promise.
 *
 * Usado para evitar que uma chamada a chrome.runtime.sendMessage fique
 * pendurada para sempre: quando o destinatário ainda não registrou seu
 * listener, o callback às vezes nunca é invocado (nem sucesso, nem
 * lastError), então um `await` simples nunca devolve o controle.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
