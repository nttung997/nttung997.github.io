function decode() {
  let code = document.getElementById('floatingTextarea').value
  if (null != code && "" != code) {
    var t = -1 == code.indexOf(" "); t || (code = code.split(" "));
    for (var result = "", a = 0; a < code.length; a += t ? 2 : 1) {
      result += String.fromCharCode(parseInt(t ? code.substr(a, 2) : code[a], 16))
    };
  }
  let link = document.getElementById('link')
  link.href = result
  link.innerText = result
}
