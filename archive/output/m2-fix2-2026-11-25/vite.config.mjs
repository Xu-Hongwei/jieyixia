import base from '../../frontend/vite.config.js';
export default {...base,root:'E:/qoder/frontend',test:{...base.test,globals:true,include:['E:/qoder/output/m2-fix2-2026-11-25/edge.test.js']}}