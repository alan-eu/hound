import {NotionCleanupFilenameMaybe, UrlToRepo, UrlToNotionMaybe} from './common';


var Signal = function() {
};

Signal.prototype = {
  listeners : [],

  tap: function(l) {
    // Make a copy of the listeners to avoid the all too common
    // subscribe-during-dispatch problem
    this.listeners = this.listeners.slice(0);
    this.listeners.push(l);
  },

  untap: function(l) {
    var ix = this.listeners.indexOf(l);
    if (ix == -1) {
      return;
    }

    // Make a copy of the listeners to avoid the all to common
    // unsubscribe-during-dispatch problem
    this.listeners = this.listeners.slice(0);
    this.listeners.splice(ix, 1);
  },

  raise: function() {
    var args = Array.prototype.slice.call(arguments, 0);
    this.listeners.forEach(function(l) {
      l.apply(this, args);
    });
  }
};

var css = function(el, n, v) {
  el.style.setProperty(n, v, '');
};

var FormatNumber = function(t) {
  var s = '' + (t|0),
      b = [];
  while (s.length > 0) {
    b.unshift(s.substring(s.length - 3, s.length));
    s = s.substring(0, s.length - 3);
  }
  return b.join(',');
};

var ParamsFromQueryString = function(qs, params) {
  params = params || {};

  if (!qs) {
    return params;
  }

  qs.substring(1).split('&').forEach(function(v) {
    var pair = v.split('=');
    if (pair.length != 2) {
      return;
    }

    // Handle classic '+' representation of spaces, such as is used
    // when Hound is set up in Chrome's Search Engine Manager settings
    pair[1] = pair[1].replace(/\+/g, ' ');

    params[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1]);
  });


  return params;
};

var ParamsFromUrl = function(params) {
  params = params || {
    q: '',
    i: 'true',
    files: '',
    excludeFiles: '',
    repos: '*'
  };
  return ParamsFromQueryString(location.search, params);
};

var ParamValueToBool = function(v) {
  v = v.toLowerCase();
  return v == 'fosho' || v == 'true' || v == '1';
};

const THEMES = {
  light: {
    ["background-color"]: "#fff",
    ["border-color"]: "#ccc",
    ["dark-background-color"]: "#f5f5f5",
    ["text-color"]: "#333",
  },
  dark: {
    ["background-color"]: "#333",
    ["border-color"]: "#666",
    ["dark-background-color"]: "#444",
    ["text-color"]: "#ddd",
  }
}

/**
 * The data model for the UI is responsible for conducting searches and managing
 * all results.
 */
var Model = {
  // raised when a search begins
  willSearch: new Signal(),

  // raised when a search completes
  didSearch: new Signal(),

  willLoadMore: new Signal(),

  didLoadMore: new Signal(),

  didError: new Signal(),

  didLoadRepos : new Signal(),

  ValidRepos: function(repos) {
    var all = this.repos,
        seen = {};
    return repos.filter(function(repo) {
      var valid = all[repo] && !seen[repo];
      seen[repo] = true;
      return valid;
    });
  },

  RepoCount: function() {
    return Object.keys(this.repos).length;
  },

  Load: function() {
    var _this = this;
    var next = function() {
      var params = ParamsFromUrl();
      _this.didLoadRepos.raise(_this, _this.repos);

      if (params.q !== '') {
        _this.Search(params);
      }
    };

    if (typeof ModelData != 'undefined') {
      var data = JSON.parse(ModelData),
          repos = {};
      for (var name in data) {
        repos[name] = data[name];
      }
      this.repos = repos;
      next();
      return;
    }

    $.ajax({
      url: 'api/v1/repos',
      dataType: 'json',
      success: function(data) {
        _this.repos = data;
        next();
      },
      error: function(xhr, status, err) {
        // TODO(knorton): Fix these
        console.error(err);
      }
    });
  },

  Search: function(params) {
    this.willSearch.raise(this, params);
    var _this = this,
        startedAt = Date.now();

    params = $.extend({
      stats: 'fosho',
      repos: '*',
      rng: ':20',
      order: 'true',
    }, params);

    if (params.excludeFiles === '') {
      params.excludeFiles = 'OLD|DEPRECATED|Copy of';
    }

    if (params.repos === '') {
      params.repos = '*';
    }

    _this.params = params;

    // An empty query is basically useless, so rather than
    // sending it to the server and having the server do work
    // to produce an error, we simply return empty results
    // immediately in the client.
    if (params.q == '') {
      _this.results = [];
      _this.resultsByRepo = {};
      _this.didSearch.raise(_this, _this.Results);
      return;
    }

    $.ajax({
      url: 'api/v1/search',
      data: params,
      type: 'GET',
      dataType: 'json',
      success: function(data) {
        if (data.Error) {
          _this.didError.raise(_this, data.Error);
          return;
        }

        var matches = data.Results,
            stats = data.Stats,
            results = [];
        for (var repo in matches) {
          if (!matches[repo]) {
            continue;
          }

          var res = matches[repo]
          var resMatches = res.Matches
          // resMatches.sort(function(a,b) {
          //     return(ComputeScoreFileMatch(b) - ComputeScoreFileMatch(a))
          // })
          // // TODO: fix that to be able to load more on demand
          // resMatches = resMatches.slice(0, 200);
          results.push({
            Repo: repo,
            Rev: res.Revision,
            Matches: resMatches,
            FilesWithMatch: res.FilesWithMatch,
          });
        }

        results.sort(function(a, b) {
          return b.Matches.length - a.Matches.length || a.Repo.localeCompare(b.Repo);
        });

        var byRepo = {};
        results.forEach(function(res) {
          byRepo[res.Repo] = res;
        });

        _this.results = results;
        _this.resultsByRepo = byRepo;
        _this.stats = {
          Server: stats.Duration,
          Total: Date.now() - startedAt,
          Files: stats.FilesOpened
        };

        _this.didSearch.raise(_this, _this.results, _this.stats);
      },
      error: function(xhr, status, err) {
        _this.didError.raise(this, "The server broke down");
      }
    });
  },

  LoadMore: function(repo) {
    var _this = this,
        results = this.resultsByRepo[repo],
        numLoaded = results.Matches.length,
        numNeeded = results.FilesWithMatch - numLoaded,
        numToLoad = Math.min(50, numNeeded),
        endAt = numNeeded == numToLoad ? '' : '' + numToLoad;

    _this.willLoadMore.raise(this, repo, numLoaded, numNeeded, numToLoad);

    var params = $.extend(this.params, {
      rng: numLoaded+':'+endAt,
      repos: repo
    });

    $.ajax({
      url: 'api/v1/search',
      data: params,
      type: 'GET',
      dataType: 'json',
      success: function(data) {
        if (data.Error) {
          _this.didError.raise(_this, data.Error);
          return;
        }

        var result = data.Results[repo];
        results.Matches = results.Matches.concat(result.Matches);
        _this.didLoadMore.raise(_this, repo, _this.results);
      },
      error: function(xhr, status, err) {
        _this.didError.raise(this, "The server broke down");
      }
    });
  },

  NameForRepo: function(repo) {
    var info = this.repos[repo];
    if (!info) {
      return repo;
    }

    var url = info.url,
        ax = url.lastIndexOf('/');
    if (ax  < 0) {
      return repo;
    }

    var name = url.substring(ax + 1).replace(/\.git$/, '');

    var bx = url.lastIndexOf('/', ax - 1);
    if (bx < 0) {
      return name;
    }

    return url.substring(bx + 1, ax) + ' / ' + name;
  },

  UrlToRepo: function(repo, path, line, rev) {
    return UrlToRepo(this.repos[repo], path, line, rev);
  }

};

var RepoOption = React.createClass({
  render: function() {
    return (
      <option value={this.props.value} selected={this.props.selected}>{this.props.value}</option>
    )
  }
});

var SearchBar = React.createClass({
  componentWillMount: function() {
    var _this = this;
    Model.didLoadRepos.tap(function(model, repos) {
      _this.setState({ allRepos: Object.keys(repos) });
    });
  },

  componentDidMount: function() {
    var q = this.refs.q.getDOMNode();

    // TODO(knorton): Can't set this in jsx
    q.setAttribute('autocomplete', 'off');

    this.setParams(this.props);

    if (this.hasAdvancedValues()) {
      this.showAdvanced();
    }

    this.initTheme();

    q.focus();
  },
  getInitialState: function() {
    return {
      state: null,
      allRepos: [],
      repos: []
    };
  },
  queryGotKeydown: function(event) {
    switch (event.keyCode) {
    case 40:
      // this will cause advanced to expand if it is not expanded.
      this.refs.files.getDOMNode().focus();
      break;
    case 38:
      this.hideAdvanced();
      break;
    case 13:
      this.submitQuery();
      break;
    }
  },
  queryGotFocus: function(event) {
    if (!this.hasAdvancedValues()) {
      this.hideAdvanced();
    }
  },
  filesGotKeydown: function(event) {
    switch (event.keyCode) {
    case 38:
      // if advanced is empty, close it up.
      if (this.isAdvancedEmpty()) {
        this.hideAdvanced();
      }
      this.refs.q.getDOMNode().focus();
      break;
    case 13:
      this.submitQuery();
      break;
    }
  },
  filesGotFocus: function(event) {
    this.showAdvanced();
  },
  excludeFilesGotKeydown: function(event) {
    switch (event.keyCode) {
    case 38:
      // if advanced is empty, close it up.
      if (this.isAdvancedEmpty()) {
        this.hideAdvanced();
      }
      this.refs.q.getDOMNode().focus();
      break;
    case 13:
      this.submitQuery();
      break;
    }
  },
  excludeFilesGotFocus: function(event) {
    this.showAdvanced();
  },
  submitQuery: function() {
    this.props.onSearchRequested(this.getParams());
  },
  getRegexpFlags : function() {
    return(this.refs.icase.getDOMNode().checked ? 'ig' : 'g');
  },
  getParams: function() {
    // selecting all repos is the same as not selecting any, so normalize the url
    // to have none.
    var repos = Model.ValidRepos(this.refs.repos.state.value);
    if (repos.length == Model.RepoCount()) {
      repos = [];
    }

    return {
      q : this.refs.q.getDOMNode().value.trim(),
      files : this.refs.files.getDOMNode().value.trim(),
      excludeFiles : this.refs.excludeFiles.getDOMNode().value.trim(),
      repos : repos.join(','),
      i: this.refs.icase.getDOMNode().checked ? 'fosho' : 'nope'
    };
  },
  setParams: function(params) {
    var q = this.refs.q.getDOMNode(),
        i = this.refs.icase.getDOMNode(),
        files = this.refs.files.getDOMNode(),
        excludeFiles = this.refs.excludeFiles.getDOMNode();

    q.value = params.q;
    i.checked = ParamValueToBool(params.i);
    files.value = params.files;
    excludeFiles.value = params.excludeFiles;
  },
  hasAdvancedValues: function() {
    return this.refs.files.getDOMNode().value.trim() !== '' || this.refs.excludeFiles.getDOMNode().value.trim() !== '' || this.refs.repos.getDOMNode().value !== '';
  },
  isAdvancedEmpty: function() {
    return this.refs.files.getDOMNode().value.trim() === '' && this.refs.excludeFiles.getDOMNode().value.trim() === '';
  },
  showAdvanced: function() {
    var adv = this.refs.adv.getDOMNode(),
        ban = this.refs.ban.getDOMNode(),
        q = this.refs.q.getDOMNode(),
        files = this.refs.files.getDOMNode(),
        excludeFiles = this.refs.excludeFiles.getDOMNode();

    css(adv, 'height', 'auto');
    css(adv, 'padding', '10px 0');

    css(ban, 'max-height', '0');
    css(ban, 'opacity', '0');
  },
  hideAdvanced: function() {
    var adv = this.refs.adv.getDOMNode(),
        ban = this.refs.ban.getDOMNode(),
        q = this.refs.q.getDOMNode();

    css(adv, 'height', '0');
    css(adv, 'padding', '0');

    css(ban, 'max-height', '100px');
    css(ban, 'opacity', '1');

    q.focus();
  },
  initTheme: function () {
    const themeLabels = Object.keys(THEMES)
    const currentThemeLabel = localStorage.getItem("theme") || themeLabels[0];
    this.setTheme(currentThemeLabel)
  },
  setTheme: function (themeLabel) {
    localStorage.setItem("theme", themeLabel);
    Object.entries(THEMES[themeLabel]).map(([key, value]) => document.documentElement.style.setProperty(`--${key}`, value))
  },
  toggleTheme: function () {
    const themeLabels = Object.keys(THEMES)
    const currentThemeLabel = localStorage.getItem("theme") || themeLabels[0];
    const nextThemeLabel = themeLabels.find((key) => key !== currentThemeLabel);

    this.setTheme(nextThemeLabel)
  },
  render: function() {
    var repoCount = this.state.allRepos.length,
        repoOptions = [],
        selected = {};

    this.state.repos.forEach(function(repo) {
      selected[repo] = true;
    });

    this.state.allRepos.forEach(function(repoName) {
      repoOptions.push(<RepoOption value={repoName} selected={selected[repoName]}/>);
    });

    var stats = this.state.stats;
    var statsView = '';
    if (stats) {
      statsView = (
        <div className="stats">
          <div>
          </div>
          <div className="val link" onClick={this.toggleTheme}>
              Switch to light/dark theme
          </div>
          <div>
            <div className="val">{FormatNumber(stats.Total)}ms total</div> /
            <div className="val">{FormatNumber(stats.Server)}ms server</div> /
            <div className="val">{stats.Files} files</div>
          </div>
        </div>
      );
    }

    return (
      <div id="input">
        <div id="ina">
          <input id="q"
              type="text"
              placeholder="Search by keyword"
              ref="q"
              autocomplete="off"
              onKeyDown={this.queryGotKeydown}
              onFocus={this.queryGotFocus}/>
          <div className="button-add-on">
            <button id="dodat" onClick={this.submitQuery}></button>
          </div>
        </div>

        <div id="inb">
          <div id="adv" ref="adv">
            <span className="octicon octicon-chevron-up hide-adv" onClick={this.hideAdvanced}></span>
            <div className="field">
              <label htmlFor="files">Match only Titles</label>
              <div className="field-input">
                <input type="text"
                    id="files"
                    placeholder="regexp"
                    ref="files"
                    onKeyDown={this.filesGotKeydown}
                    onFocus={this.filesGotFocus} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="excludeFiles">Exclude Titles like</label>
              <div className="field-input">
                <input type="text"
                    id="excludeFiles"
                    placeholder="regexp"
                    ref="excludeFiles"
                    onKeyDown={this.excludeFilesGotKeydown}
                    onFocus={this.excludeFilesGotFocus} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="ignore-case">Ignore Case</label>
              <div className="field-input">
                <input id="ignore-case" type="checkbox" ref="icase" />
              </div>
            </div>
            <div className="field">
              <label className="multiselect_label" htmlFor="repos">Select Repo</label>
              <div className="field-input">
                <select id="repos" className="form-control multiselect" multiple={true} size={Math.min(16, repoCount)} ref="repos">
                  {repoOptions}
                </select>
              </div>
            </div>
          </div>
          <div className="ban" ref="ban" onClick={this.showAdvanced}>
            <span className="octicon octicon-chevron-down show-hide-matches"></span>
            Advanced search, ignore case, filter by titles...
          </div>
        </div>
        {statsView}
      </div>
    );
  }
});

/**
 * Compare Results
 */

var ComputeScoreFileMatch = function(match) {
    var score = 0
    if (match.FoundInTitle) { score = score + 5000 }
    if (match.ImportantTitle) { score = score + 10000 }
    score = score + match.Matches.length
    var deepness = match.Deepness
    score = score / deepness
    return score
}

/**
 * Take a list of matches and turn it into a simple list of lines.
 */
var MatchToLines = function(match) {
  var lines = [],
      base = match.LineNumber,
      nBefore = match.Before.length,
      nAfter = match.After.length;
  match.Before.forEach(function(line, index) {
    lines.push({
      Number : base - nBefore + index,
      Content: line,
      Match: false
    });
  });

  lines.push({
    Number: base,
    Content: match.Line,
    Match: true
  });

  match.After.forEach(function(line, index) {
    lines.push({
      Number: base + index + 1,
      Content: line,
      Match: false
    });
  });

  return lines;
};

/**
 * Take several lists of lines each representing a matching block and merge overlapping
 * blocks together. A good example of this is when you have a match on two consecutive
 * lines. We will merge those into a singular block.
 *
 * TODO(knorton): This code is a bit skanky. I wrote it while sleepy. It can surely be
 * made simpler.
 */
var CoalesceMatches = function(matches) {
  var blocks = matches.map(MatchToLines),
      res = [],
      current;
  // go through each block of lines and see if it overlaps
  // with the previous.
  for (var i = 0, n = blocks.length; i < n; i++) {
    var block = blocks[i],
        max = current ? current[current.length - 1].Number : -1;
    // if the first line in the block is before the last line in
    // current, we'll be merging.
    if (block[0].Number <= max) {
      block.forEach(function(line) {
        if (line.Number > max) {
          current.push(line);
        } else if (current && line.Match) {
          // we have to go back into current and make sure that matches
          // are properly marked.
          current[current.length - 1 - (max - line.Number)].Match = true;
        }
      });
    } else {
      if (current) {
        res.push(current);
      }
      current = block;
    }
  }

  if (current) {
    res.push(current);
  }

  return res;
};

/**
 * Use the DOM to safely htmlify some text.
 */
var EscapeHtml = function(text) {
  var e = EscapeHtml.e;
  e.textContent = text;
  return e.innerHTML;
};
EscapeHtml.e = document.createElement('div');

/**
 * Produce html for a line using the regexp to highlight matches.
 */
var ContentFor = function(line, regexp, parse_markdown) {
  if (!line.Match) {
    var ret = EscapeHtml(line.Content);
    if (parse_markdown) {
      ret = MarkdownToHtml.parse(ret)
    }
    return ret
  }
  var content = line.Content,
      buffer = [];

  while (true) {
    regexp.lastIndex = 0;
    var m = regexp.exec(content);
    if (!m) {
      buffer.push(EscapeHtml(content));
      break;
    }

    buffer.push(EscapeHtml(content.substring(0, regexp.lastIndex - m[0].length)));
    buffer.push( '<em>' + EscapeHtml(m[0]) + '</em>');
    content = content.substring(regexp.lastIndex);
  }
  var ret = buffer.join('');
  if (parse_markdown) {
    ret = MarkdownToHtml.parse(ret)
  }
  return ret
};

var FilesView = React.createClass({
  onLoadMore: function(event) {
    Model.LoadMore(this.props.repo);
  },

  render: function() {
    var _this = this
    var rev = this.props.rev,
        repo = this.props.repo,
        regexpFlags = this.props.regexpFlags,
        matches = this.props.matches,
        totalMatches = this.props.totalMatches;
    var files = matches.map(function(match, index) {
      var finalQuery = match.FinalQuery
      var regexp = new RegExp(finalQuery, regexpFlags);
      var filename = match.Filename,
          blocks = CoalesceMatches(match.Matches);
      var matches = blocks.map(function(block) {
        var lines = block.map(function(line) {
            if (repo.match(/^notion_/)) {
              var content = ContentFor(line, regexp, false);
              return (
                <div className="line">
                  <span className="lnum">{' '.repeat(5-(line.Number+'').length)}{line.Number}</span>
                  <span className="lval" dangerouslySetInnerHTML={{__html:content}} />
                </div>)
            } else {
              var content = ContentFor(line, regexp, false);
              return (
                <div className="line">
                  <a href={Model.UrlToRepo(repo, filename, line.Number, rev)}
                    className="lnum" target="_blank">{line.Number}</a>
                  <span className="lval" dangerouslySetInnerHTML={{__html:content}} />
                </div>);
            }
        });

        return (
          <div className="match">{lines}</div>
        );
      });

      var showFileBody = function() {
        var fileBody = _this.refs["fileBody" + index].getDOMNode()
        var buttonUp = _this.refs["buttonUp" + index].getDOMNode()
        var buttonDown = _this.refs["buttonDown" + index].getDOMNode()
        fileBody.style.display = 'block';
        buttonUp.style.display = 'inline';
        buttonDown.style.display = 'none';
      }
      var hideFileBody = function() {
        var fileBody = _this.refs["fileBody" + index].getDOMNode()
        var buttonUp = _this.refs["buttonUp" + index].getDOMNode()
        var buttonDown = _this.refs["buttonDown" + index].getDOMNode()
        fileBody.style.display = 'none';
        buttonUp.style.display = 'none';
        buttonDown.style.display = 'inline';
      }
            // <span className="octicon octicon-chevron-down show-hide-matches" onClick={showFileBody}></span>
            // <span className="octicon octicon-chevron-up show-hide-matches" onClick={hideFileBody} ref={"buttonUp" + index} style="display:none;"></span>
        return (
            <div className="file">
          <div className="title">
            <span className="octicon octicon-chevron-down show-hide-matches" onClick={showFileBody} ref={"buttonDown" + index} style={{display: (index < 2) ? "none" : "inline"}}></span>
            <span className="octicon octicon-chevron-up show-hide-matches" onClick={hideFileBody} ref={"buttonUp" + index} style={{display: (index < 2) ? "inline" : "none"}}></span>
            <a href={UrlToNotionMaybe(match.Filename, repo)} className="notion-link">
                {NotionCleanupFilenameMaybe(match.Filename, repo)
                  .split("▶")
                  .map((depthLabel, index) => (<span>{index > 0 && "▶"}{depthLabel}</span>))}
          </a><br/>
          </div>
            <div className="file-body" ref={"fileBody" + index} style={{display: (index < 2) ? "inline" : "none"}}>
            {matches}
              <small className="legend"><u>Important file:</u> {match.ImportantTitle ? "yes" : "no"}, <u>Found in title:</u> {match.FoundInTitle ? "yes" : "no"}, <u>Matches count:</u> {match.Matches.length}</small>
          </div>
        </div>
      );
    });

    var more = '';
    if (matches.length < totalMatches) {
      more = (<button className="moar" onClick={this.onLoadMore}>Load 50 more results ({matches.length} out of {totalMatches} matches) in {Model.NameForRepo(repo)}</button>);
    }

    return (
      <div className="files">
      {files}
      {more}
      </div>
    );
  }
});

var ResultView = React.createClass({
  componentWillMount: function() {
    var _this = this;
    Model.willSearch.tap(function(model, params) {
      _this.setState({
        results: null,
        query: params.q
      });
    });
  },
  getInitialState: function() {
    return { results: null };
  },
  render: function() {
    if (this.state.error) {
      return (
        <div id="no-result" className="error">
          <strong>ERROR:</strong>{this.state.error}
        </div>
      );
    }

    if (this.state.results !== null && this.state.results.length === 0) {
      // TODO(knorton): We need something better here. :-(
      return (
        <div id="no-result">No results<div>0 results</div></div>
      );
    }

    if (this.state.results === null && this.state.query) {
      return (
        <div id="no-result"><img src="images/busy.gif" /><div>Searching...</div></div>
      );
    }

    var regexpFlags = this.state.regexpFlags,
        results = this.state.results || [];
    var repos = results.map(function(result, index) {
      return (
        <div className="repo">
          <div className="title">
            <span className="mega-octicon octicon-repo"></span>
            <span className="name">{Model.NameForRepo(result.Repo)}</span>
          </div>
          <FilesView matches={result.Matches}
              rev={result.Rev}
              repo={result.Repo}
              regexpFlags={regexpFlags}
              totalMatches={result.FilesWithMatch} />
        </div>
      );
    });
    return (
      <div id="result">{repos}</div>
    );
  }
});

var App = React.createClass({
  componentWillMount: function() {
    var params = ParamsFromUrl(),
        repos = (params.repos == '') ? [] : params.repos.split(',');

    this.setState({
      q: params.q,
      i: params.i,
      files: params.files,
      excludeFiles: params.excludeFiles,
      repos: repos
    });

    var _this = this;
    Model.didLoadRepos.tap(function(model, repos) {
      // If all repos are selected, don't show any selected.
      if (model.ValidRepos(_this.state.repos).length == model.RepoCount()) {
        _this.setState({repos: []});
      }
    });

    Model.didSearch.tap(function(model, results, stats) {
      _this.refs.searchBar.setState({
        stats: stats,
        repos: repos,
      });

      _this.refs.resultView.setState({
        results: results,
        regexpFlags: _this.refs.searchBar.getRegexpFlags(),
        error: null
      });
    });

    Model.didLoadMore.tap(function(model, repo, results) {
      _this.refs.resultView.setState({
        results: results,
        regexpFlags: _this.refs.searchBar.getRegexpFlags(),
        error: null
      });
    });

    Model.didError.tap(function(model, error) {
      _this.refs.resultView.setState({
        results: null,
        error: error
      });
    });

    window.addEventListener('popstate', function(e) {
      var params = ParamsFromUrl();
      _this.refs.searchBar.setParams(params);
      Model.Search(params);
    });
  },
  onSearchRequested: function(params) {
    this.updateHistory(params);
    Model.Search(this.refs.searchBar.getParams());
  },
  updateHistory: function(params) {
    var path = location.pathname +
      '?q=' + encodeURIComponent(params.q) +
      '&i=' + encodeURIComponent(params.i) +
      '&files=' + encodeURIComponent(params.files) +
      '&excludeFiles=' + encodeURIComponent(params.excludeFiles) +
      '&repos=' + params.repos;
    history.pushState({path:path}, '', path);
  },
  render: function() {
    return (
      <div>
        <SearchBar ref="searchBar"
            q={this.state.q}
            i={this.state.i}
            files={this.state.files}
            excludeFiles={this.state.excludeFiles}
            repos={this.state.repos}
            onSearchRequested={this.onSearchRequested} />
        <ResultView ref="resultView" q={this.state.q} />
      </div>
    );
  }
});

React.renderComponent(
  <App />,
  document.getElementById('root')
);
Model.Load();
