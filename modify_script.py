import codecs

target = """function showConfirm(title, message, onConfirm, confirmLabel = 'Confirm', confirmStyle = 'primary', onCancel = null) {
    const ICON_MAP = { danger: '⚠️', primary: '▶', success: '✅' };
    const icon = ICON_MAP[confirmStyle] || '❓';
    const box = el('div');
    box.innerHTML = `
    <div class="confirm-icon">${icon}</div>
    <div class="confirm-title">${title}</div>
    <div class="confirm-msg">${message.replace(/\\n/g, '<br>')}</div>
    <div class="confirm-footer">
      <button class="btn btn-ghost" id="conf-cancel">Cancel</button>
      <button class="btn btn-${confirmStyle}" id="conf-ok">${confirmLabel}</button>
    </div>`;
    showModal(box);
    document.getElementById('conf-cancel').addEventListener('click', () => { hideModal(); if (onCancel) onCancel(); });
    document.getElementById('conf-ok').addEventListener('click', () => { hideModal(); onConfirm(); });
}"""

replacement = """function showConfirm(title, message, onConfirm, confirmLabel = 'Confirm', confirmStyle = 'primary', onCancel = null) {
    const ICON_MAP = { danger: '&#10006;', primary: '&#9432;', success: '&#10004;', warning: '&#9888;' };
    const icon = ICON_MAP[confirmStyle] || '&#9888;';
    
    let kicker = 'Action Required';
    if (confirmStyle === 'danger') kicker = 'Critical Action';
    if (title.includes('Enable') || title.includes('Disable')) kicker = 'Job Configuration';
    if (title.includes('Server')) kicker = 'Server Management';

    const box = el('div', 'run-confirm-modal');
    box.innerHTML = `
    <div class="run-confirm-hero">
      <div class="run-confirm-icon ${confirmStyle}-icon">${icon}</div>
      <div class="run-confirm-kicker">${kicker}</div>
      <div class="run-confirm-title">${title}</div>
      <div class="run-confirm-sub">${message.replace(/\\n/g, '<br>')}</div>
    </div>
    <div class="modal-footer run-confirm-footer">
      <button class="btn btn-ghost" id="conf-cancel">Cancel</button>
      <button class="btn btn-${confirmStyle}" id="conf-ok">${confirmLabel}</button>
    </div>`;
    showModal(box);
    document.getElementById('conf-cancel').addEventListener('click', () => { hideModal(); if (onCancel) onCancel(); });
    document.getElementById('conf-ok').addEventListener('click', () => { hideModal(); onConfirm(); });
}"""

with open('web/assets/app_v5.js', 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

content = content.replace(target, replacement)

with open('web/assets/app_v5.js', 'w', encoding='utf-8') as f:
    f.write(content)
