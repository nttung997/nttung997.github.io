function hexToText(input) {
  const trimmed = String(input).trim()
  if (trimmed === '') return ''

  const bytes = []
  for (const group of trimmed.split(/\s+/)) {
    const hex = group.replace(/^(?:0x|\\x)/i, '')
    const isEvenHex = hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-f]+$/i.test(hex)
    if (!isEvenHex) {
      throw new Error('Invalid hex. Use even-length digit groups, with an optional 0x or \\x prefix.')
    }
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.slice(i, i + 2), 16))
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes))
}

function isHttpUrl(text) {
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function decode() {
  const link = document.getElementById('link')
  const error = document.getElementById('decode-error')
  const input = document.getElementById('floatingTextarea').value

  error.textContent = ''
  link.textContent = ''
  link.removeAttribute('href')

  if (input.trim() === '') return

  try {
    const text = hexToText(input)
    link.textContent = text
    if (isHttpUrl(text)) link.href = text
  } catch (err) {
    error.textContent = err.message
  }
}
