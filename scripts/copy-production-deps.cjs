const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Copy the exact installed graph into ordinary portable directories. Never
// resolve new versions from a registry or carry pnpm's absolute junctions.
function copyProductionDependencies(project, destination) {
  const installed = new Map();
  const metadata = [];
  const locate = (name, from) => {
    const search = createRequire(path.join(from, 'package.json')).resolve.paths('__farm_dependency_lookup__') || [];
    for (const directory of search) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    }
    throw new Error('Missing installed dependency: ' + name);
  };
  const rootModules = path.join(destination, 'node_modules');
  const add = (name, source, parent) => {
    const resolved = fs.realpathSync(source);
    // Reuse only copies visible through Node's real ancestor search order.
    const search = createRequire(path.join(parent, 'package.json')).resolve.paths('__farm_dependency_lookup__') || [];
    for (const modules of search) {
      const existing = path.join(modules, name);
      if (installed.has(existing)) {
        if (installed.get(existing) === resolved) return;
        break;
      }
    }
    let target = path.join(rootModules, name);
    if (installed.has(target) && installed.get(target) !== resolved) target = path.join(parent, 'node_modules', name);
    if (installed.get(target) === resolved) return;
    installed.set(target, resolved);
    fs.cpSync(resolved, target, { recursive: true, dereference: true,
      filter: file => !path.relative(resolved, file).split(path.sep).some(part => ['node_modules', '.git'].includes(part)) });
    const pkg = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8'));
    metadata.push({ name: pkg.name, version: pkg.version, directory: path.relative(destination, target).split(path.sep).join('/') });
    const dependencies = { ...pkg.peerDependencies, ...pkg.optionalDependencies, ...pkg.dependencies };
    for (const dependency of Object.keys(dependencies || {})) {
      let input;
      try { input = locate(dependency, resolved); }
      catch (error) {
        if (Object.hasOwn(pkg.optionalDependencies || {}, dependency) || pkg.peerDependenciesMeta?.[dependency]?.optional) continue;
        throw error;
      }
      add(dependency, input, target);
    }
  };
  const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  // Reserve root direct dependencies first, preventing transitive hoisting
  // from shadowing a direct dependency with another version.
  for (const name of Object.keys(pkg.dependencies || {})) {
    installed.set(path.join(rootModules, name), locate(name, project));
  }
  const reserved = new Map(installed); installed.clear();
  for (const [target, source] of reserved) {
    fs.cpSync(source, target, { recursive: true, dereference: true,
      filter: file => !path.relative(source, file).split(path.sep).some(part => ['node_modules', '.git'].includes(part)) });
    installed.set(target, source);
  }
  for (const [target, source] of reserved) {
    const value = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    metadata.push({ name: value.name, version: value.version, directory: path.relative(destination, target).split(path.sep).join('/') });
    for (const name of Object.keys({ ...value.peerDependencies, ...value.optionalDependencies, ...value.dependencies })) {
      let input;
      try { input = locate(name, source); }
      catch (error) {
        if (Object.hasOwn(value.optionalDependencies || {}, name) || value.peerDependenciesMeta?.[name]?.optional) continue;
        throw error;
      }
      add(name, input, target);
    }
  }
  return metadata;
}
module.exports = { copyProductionDependencies };
