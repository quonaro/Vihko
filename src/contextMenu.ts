export function disableBrowserContextMenu() {
  const preventContextMenu = (event: Event) => event.preventDefault()
  document.addEventListener('contextmenu', preventContextMenu, true)

  return () => document.removeEventListener('contextmenu', preventContextMenu, true)
}
