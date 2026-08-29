// memoria kota v2 — ローカル意味埋め込み（Apple NaturalLanguage・外部送信なし）
// usage: embed  (stdinから1行=1テキスト、stdoutにJSON配列の配列)
// NLContextualEmbedding(多言語・日本語対応)を優先、失敗時はexit 2（呼び出し側がTF-IDFへフォールバック）
import Foundation
import NaturalLanguage

guard #available(macOS 14.0, *) else { exit(2) }
guard let emb = NLContextualEmbedding(language: .japanese) else { exit(2) }
if !emb.hasAvailableAssets {
  let sem = DispatchSemaphore(value: 0)
  var ok = false
  emb.requestAssets { result, _ in ok = (result == .available); sem.signal() }
  sem.wait()
  if !ok { exit(2) }
}
try? emb.load()

var lines: [String] = []
while let l = readLine(strippingNewline: true) { lines.append(l) }

var out: [[Double]] = []
for line in lines {
  let text = String(line.prefix(600))
  guard !text.isEmpty, let res = try? emb.embeddingResult(for: text, language: .japanese) else {
    out.append([]); continue
  }
  var sum = [Double](repeating: 0, count: emb.dimension)
  var n = 0
  res.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { vec, _ in
    for (i, v) in vec.enumerated() { sum[i] += v }
    n += 1
    return true
  }
  if n == 0 { out.append([]); continue }
  let mean = sum.map { ($0 / Double(n) * 10000).rounded() / 10000 }
  out.append(mean)
}
let data = try! JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
