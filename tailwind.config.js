/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './bombastico.js'],
  theme: {
    extend: {
      spacing: {
        '1.2': '0.3rem',
        '18': '4.5rem',
      },
    },
  },
  plugins: [],
}
