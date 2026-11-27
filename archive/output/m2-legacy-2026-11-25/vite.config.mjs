import base from '../../frontend/vite.config.js';
export default {...base,root:'E:/qoder/frontend',test:{...base.test,globals:true,include:['E:/qoder/output/m2-legacy-2026-11-25/edge.test.js']}}