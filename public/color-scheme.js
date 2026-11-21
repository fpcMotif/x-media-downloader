const storedScheme = localStorage.getItem('xmd-color-scheme')
if (storedScheme === 'light' || storedScheme === 'dark') {
  document.querySelector('meta[name="color-scheme"]').content = storedScheme
}
