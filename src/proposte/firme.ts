// I primi byte di un file devono corrispondere al suo formato (lo controlla anche Costructo): un file che dice di essere
// un PDF ma non lo è non si salva e non si manda.
export function contenutoCoerente(dati: Buffer, mime: string): boolean {
  const inizio = (s: string, da = 0) => dati.length >= da + s.length && dati.subarray(da, da + s.length).toString("latin1") === s;
  switch (mime) {
    case "application/pdf": return inizio("%PDF-");
    case "image/jpeg": return dati.length > 3 && dati[0] === 0xff && dati[1] === 0xd8 && dati[2] === 0xff;
    case "image/png": return inizio("\x89PNG\r\n\x1a\n");
    case "image/webp": return inizio("RIFF") && inizio("WEBP", 8);
    case "image/heic": return inizio("ftyp", 4) && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(dati.subarray(8, 12).toString("latin1"));
    default: return false;
  }
}
