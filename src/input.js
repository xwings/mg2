export function createInput(){
  const keys = new Set(), pressed = new Set(), prev = new Set();
  onkeydown = e => {
    keys.add(e.code);
    if(e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Enter' || e.code === 'Escape') e.preventDefault();
  };
  onkeyup = e => keys.delete(e.code);
  function updateKeys(){
    pressed.clear();
    for(const k of keys) if(!prev.has(k)) pressed.add(k);
    prev.clear();
    for(const k of keys) prev.add(k);
  }
  return {keys, pressed, updateKeys};
}
