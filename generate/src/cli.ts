#! node
import { make } from './esy';
import {
  folder_sha1,
  sha1,
  map,
  replace_all,
  target_name,
  escape_name,
  exec,
} from './lib';
import { build, install } from './commands';
import { t as node_t } from './node';
import fs from 'fs';
import env from './env';
import get_patch from './patch';

const esy = fs.existsSync('./esy.json')
  ? make('esy.json')
  : make('package.json');
const targets = (() => {
  const manifest_targets = esy.manifest.targets;
  if (!manifest_targets) {
    if (!process.argv[2]) {
      console.error('you should specify a target: generate <system>.<arch>');
      process.exit(1);
    }
    const parts = process.argv[2].split('.');
    const [arch] = parts.slice(-1);
    const system = parts.slice(0, -1).join('.');
    return [{ system, arch, name: `${system}.${arch}` }];
  }

  const systems = Object.keys(manifest_targets);
  return systems.flatMap((system) =>
    manifest_targets[system].map((arch) => ({
      system,
      arch,
      name: `${system}.${arch}`,
    }))
  );
})();
const create_nodes = async () => {
  const nodes = Object.values(esy.lock.node);

  const config = await esy.get_config();
  const dependencies_map = (() =>
    Object.fromEntries(
      nodes.map((node) => {
        const dependencies = node.dependencies
          .concat(node.devDependencies)
          .map((id) => esy.lock.node[id].name);
        return [node.name, dependencies];
      })
    ) as map<string[]>)();

  const env_plan_map = await Promise.all(
    nodes.map(async ({ name }) => {
      const [build_map, exec_env] = await Promise.all([
        esy.build_plan(name),
        esy.exec_env(name),
      ]);
      return [name, { build_map, exec_env }] as const;
    })
  ).then((entries) => Object.fromEntries(entries));

  const promises = nodes.flatMap((node) =>
    ['native', ...targets.map((target) => target.name)].map(
      async (target): Promise<node_t> => {
        const name = target_name(target, node.name);
        const native = node.name;
        const env_plan = env_plan_map[node.name];
        const exec_env = (() => {
          const fix_variable = (value: string) =>
            Object.entries(config).reduce(
              (exec_env, [key, value]) =>
                replace_all(value, `%{${key}}%`, exec_env),
              value
            );
          return Object.fromEntries(
            Object.entries(env_plan.exec_env).map(([key, value]) => {
              const new_value = fix_variable(value);
              return [key, new_value];
            })
          );
        })();
        const override_build_plan =
          (await get_patch(escape_name(node.name), exec_env.cur__version)) ||
          {};

        const build_plan = {
          ...env_plan.build_map,
          ...override_build_plan,
        };

        const override_dependencies = override_build_plan.dependencies || {};
        const source_dependencies = Object.fromEntries(
          dependencies_map[node.name].map((name) => [name, '*'])
        );
        const dependencies = Object.keys({
          ...source_dependencies,
          ...override_dependencies,
        });
        return {
          name,
          native,
          target,
          build_plan,
          exec_env,
          dependencies,
          patch: override_build_plan,
        };
      }
    )
  );
  return Promise.all(promises);
};
const add_as_mock = async (name: string, folder: string) => {
  const hash = (await folder_sha1(folder)).slice(0, 8);
  const mock_folder = `.mocks/${hash}`;
  await exec(`cp -a ${folder} ${mock_folder}`);
  return [name, `${mock_folder}/package.json`];
};
(async () => {
  const nodes = await create_nodes();
  const nodes_map = Object.fromEntries(
    nodes.map((node) => [node.name, node])
  ) as map<node_t>;

  const dependencies_map = Object.fromEntries(
    nodes.map((node) => {
      const dependencies = [
        node.native,
        target_name(node.target, 'sysroot'),
        ...node.dependencies.map((name) => target_name(node.target, name)),
      ];
      return [node.name, dependencies];
    })
  );

  const build_map = Object.fromEntries(
    nodes.map((node) => [node.name, build(nodes_map, node)])
  );
  const install_map = Object.fromEntries(
    nodes.map((node) => [node.name, install(nodes_map, node)])
  );
  const env_map = Object.fromEntries(
    nodes.map((node) => [node.name, env(nodes_map, node)])
  );

  const versions_map = Object.fromEntries(
    nodes
      .filter((node) => node.target === 'native')
      .map((node) => [node.name, node.build_plan.version])
  );
  const nodes_to_patch = nodes.filter((node) => node.target !== 'native');
  const mocks = nodes_to_patch.map((node) => {
    const exportedEnv = env_map[node.name].exported_env;
    if (node.name === target_name(node.target, 'ocaml')) {
      exportedEnv.ESY_TOOLCHAIN_OCAML = {
        scope: 'global',
        val: `#{self.install}/${node.target}-sysroot`,
      };
    }
    const raw_dependencies = Object.keys(
      (node.patch && node.patch.raw_dependencies) || {}
    );
    const mock = {
      name: node.name,
      dependencies: Object.fromEntries(
        dependencies_map[node.name].concat(raw_dependencies).map((name) => {
          const version = (versions_map[name] || '*').split(':');
          return [
            name,
            (version.length === 1 ? version : version.slice(1)).join(':'),
          ];
        })
      ),
      esy: {
        buildsInSource: true,
        buildEnv: env_map[node.name].build_env,
        exportedEnv,
        build: build_map[node.name],
        install: install_map[node.name],
      },
    };

    const checksum = sha1(
      JSON.stringify(mock) + (node.patch && node.patch.checksum_files_folder)
    ).slice(0, 8);
    const path = `.mocks/${checksum}`;
    const file = `${path}/esy.json`;
    return {
      name: node.name,
      mock,
      path,
      file,
      files_folder: node.patch?.files_folder,
    };
  });
  if (!fs.existsSync('.mocks')) {
    fs.mkdirSync('.mocks');
  }
  mocks.forEach(({ path, file, mock, files_folder }) => {
    if (!fs.existsSync(path)) {
      fs.mkdirSync(path);
    }

    if (files_folder) {
      const { join } = require('path');
      const new_files_folder = join(path, 'files');
      if (!fs.existsSync(new_files_folder)) {
        fs.mkdirSync(new_files_folder);
        exec(`cp -r ${files_folder}/. ${new_files_folder}`);
      }
    }
    fs.writeFileSync(file, JSON.stringify(mock, null, 2));
  });

  const resolutions_to_patch = mocks.map(({ file, mock }) => [mock.name, file]);
  const source_name = esy.lock.node[esy.lock.root].name;

  targets.forEach(async (target) => {
    const root_name = target_name(target.name, source_name);
    const root = mocks.find((mock) => mock.name == root_name)!;

    const additional_resolutions = Object.fromEntries(
      [
        await add_as_mock('generate', '../generate/bin'),
        await add_as_mock('sysroot.tools', '../sysroot/tools'),
        await add_as_mock(
          `@_${target.name}/sysroot`,
          `../sysroot/${target.name}`
        ),
        target.system === 'android' &&
          (await add_as_mock('@_android/ndk', '../sysroot/android.ndk')),
      ].filter(Boolean) as [string, string][]
    );

    const host_root_name = esy.lock.node[esy.lock.root].name;
    const dependencies = Object.entries({
      ...esy.manifest.dependencies,
      ...root.mock.dependencies,
      source_name: undefined,
      [host_root_name]: undefined,
      ...(esy.manifest.target && esy.manifest.target.dependencies),
    }).filter(([_, value]) => value);

    const wrapper = {
      dependencies: Object.fromEntries(dependencies),
      resolutions: {
        ...Object.fromEntries(resolutions_to_patch),
        ...esy.manifest.resolutions,
        ...additional_resolutions,
        ...(esy.manifest.target && esy.manifest.target.resolutions),
      },
    };

    fs.writeFileSync(`${target.name}.json`, JSON.stringify(wrapper, null, 2));
  });
})();

/* TODO: IMPORTANT, write a script to check if the files generated are right
  comparing the filesystem to the native one and checking with objdump things */
