import { version } from "@babel/core";


export function ExpandVars(template, values) {
    for (var name in values) {
        template = template.replace('{' + name + '}', values[name]);
    }
    return template;
};

export function UrlToRepo(repo, path, line, rev) {
    var url = repo.url.replace(/\.git$/, ''),
        pattern = repo['url-pattern'],
        filename = path.substring(path.lastIndexOf('/') + 1),
        anchor = line ? ExpandVars(pattern.anchor, { line : line, filename : filename }) : '';

    // Determine if the URL passed is a GitHub wiki
    var wikiUrl = /\.wiki$/.exec(url);
    if (wikiUrl) {
        url = url.replace(/\.wiki/, '/wiki')
        path = path.replace(/\.md$/, '')
        anchor = '' // wikis do not support direct line linking
    }

    // Hacky solution to fix _some more_ of the 404's when using SSH style URLs.
    // This works for both github style URLs (git@github.com:username/Foo.git) and
    // bitbucket style URLs (ssh://hg@bitbucket.org/username/Foo).

    // Regex explained: Match either `git` or `hg` followed by an `@`.
    // Next, slurp up the hostname by reading until either a `:` or `/` is found.
    // Finally, grab all remaining characters.
    var sshParts = /(git|hg)@(.*?)(:|\/)(.*)/.exec(url);
    if (sshParts) {
        url = '//' + sshParts[2] + '/' + sshParts[4];
    }

    // I'm sure there is a nicer React/jsx way to do this:
    return ExpandVars(pattern['base-url'], {
        url : url,
        path: path,
        rev: rev,
        anchor: anchor
    });
}

export function NotionCleanupFilenameMaybe(filename, repo) {
    var res = repo.match(/^notion_/)
    if (!res) {
        return filename;
    }
    var cleanupRe1 = / [0-9a-f]+\//g;
    filename = filename.replaceAll(cleanupRe1, '/');
    var cleanupRe2 = / [0-9a-f]+\.(md|csv)/g;
    filename = filename.replaceAll(cleanupRe2, '');
    var cleanupRe21 = /^pages\//;
    filename = filename.replace(cleanupRe21, '');
    var cleanupRe22 = /^databases\//;
    filename = filename.replace(cleanupRe22, '');
    var cleanupRe23 = /^pages_new\//;
    filename = filename.replace(cleanupRe23, '');
    var cleanupRe24 = /^databases_new\//;
    filename = filename.replace(cleanupRe24, '');
    var cleanupRe3 = /\//g;
    return filename.replaceAll(cleanupRe3, ' ▶ ');
}

export function UrlToNotionMaybe(filename, repo) {
    var res = repo.match(/^notion_(.*)$/)
    if (!res) {
        return filename;
    }
    var regex1 = /^.*\/([^\/]+)\.(md|csv)$/g;
    var url = filename.replace(regex1, '$1');
    var regex2 = /^.* ([a-f0-9]+)$/;
    url = url.replace(regex2, '$1');
    url = 'https://www.notion.so/' + res[1] + '/' + url;
    return url;
}
