# Eluxjob - Simulador Lumínico Profesional

**Eluxjob** es una herramienta avanzada de simulación de iluminación desarrollada con **React** y **TypeScript**. Permite realizar cálculos lumínicos precisos, importar planos arquitectónicos y visualizar fotometrías.

## 🚀 Características principales

*   **Motor de Cálculo Lumínico**: Algoritmos optimizados para determinar la distribución de luz en recintos.
*   **Soporte de Archivos IES**: Parser integrado para datos fotométricos estándar.
*   **Importación DXF**: Procesamiento de planos técnicos para definir geometrías.
*   **Visualización Interactiva**: Representación de curvas polares y gráficos en tiempo real.
*   **Biblioteca Fotométrica**: Incluye datos técnicos de luminarias profesionales (Serie Attria).

## 🛠️ Tecnologías utilizadas

*   **Frontend**: React + Vite
*   **Lenguaje**: TypeScript
*   **Visualización**: HTML5 Canvas API

## 📦 Instalación y Configuración

1.  Instalar dependencias:
    ```bash
    npm install
    ```
2.  Iniciar el servidor de desarrollo:
    ```bash
    npm run dev
    ```

## 🏗️ Estructura del proyecto

*   `/src/engine`: Lógica core de cálculo y parsers (IES/DXF).
*   `/src/components`: Componentes de interfaz y visualización.
*   `/src/pages`: Vistas principales de la aplicación.

---
Desarrollado para la industria de la iluminación técnica.
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
