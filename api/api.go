package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/alan-eu/hound/config"
	"github.com/alan-eu/hound/index"
	"github.com/alan-eu/hound/searcher"
	prmt "github.com/gitchander/permutation"
)

const (
	defaultLinesOfContext uint = 2
	maxLinesOfContext     uint = 20
)

type Stats struct {
	FilesOpened int
	Duration    int
}

func writeJson(w http.ResponseWriter, data interface{}, status int) {
	w.Header().Set("Content-Type", "application/json;charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Panicf("Failed to encode JSON: %v\n", err)
	}
}

func writeResp(w http.ResponseWriter, data interface{}) {
	writeJson(w, data, http.StatusOK)
}

func writeError(w http.ResponseWriter, err error, status int) {
	writeJson(w, map[string]string{
		"Error": err.Error(),
	}, status)
}

type searchResponse struct {
	repo string
	res  *index.SearchResponse
	err  error
}

/**
 * Searches all repos in parallel.
 */
func searchAll(
	query string,
	opts *index.SearchOptions,
	repos []string,
	idx map[string]*searcher.Searcher,
	filesOpened *int,
	duration *int) (map[string]*index.SearchResponse, error) {

	startedAt := time.Now()

	n := len(repos)

	// use a buffered channel to avoid routine leaks on errs.
	ch := make(chan *searchResponse, n)
	for _, repo := range repos {
		go func(repo string) {
			local_opts := *opts
			if strings.HasPrefix(repo, "notion_") {
				local_opts.SearchInTitles = true
			}
			fms, err := idx[repo].Search(query, &local_opts)
			ch <- &searchResponse{repo, fms, err}
		}(repo)
	}

	res := map[string]*index.SearchResponse{}
	for i := 0; i < n; i++ {
		r := <-ch
		if r.err != nil {
			return nil, r.err
		}

		if r.res.Matches == nil {
			continue
		}

		res[r.repo] = r.res
		*filesOpened += r.res.FilesOpened
	}

	*duration = int(time.Now().Sub(startedAt).Seconds() * 1000)  //nolint

	return res, nil
}

// Used for parsing flags from form values.
func parseAsBool(v string) bool {
	v = strings.ToLower(v)
	return v == "true" || v == "1" || v == "fosho"
}

func parseAsRepoList(v string, idx map[string]*searcher.Searcher) []string {
	v = strings.TrimSpace(v)
	var repos []string
	if v == "*" {
		for repo := range idx {
			repos = append(repos, repo)
		}
		return repos
	}

	for _, repo := range strings.Split(v, ",") {
		if idx[repo] == nil {
			continue
		}
		repos = append(repos, repo)
	}
	return repos
}

func parseAsUintValue(sv string, min, max, def uint) uint {
	iv, err := strconv.ParseUint(sv, 10, 54)
	if err != nil {
		return def
	}
	if max != 0 && uint(iv) > max {
		return max
	}
	if min != 0 && uint(iv) < min {
		return max
	}
	return uint(iv)
}

func parseRangeInt(v string, i *int) {
	*i = 0
	if v == "" {
		return
	}

	vi, err := strconv.ParseUint(v, 10, 64)
	if err != nil {
		return
	}

	*i = int(vi)
}

func parseRangeValue(rv string) (int, int) {
	ix := strings.Index(rv, ":")
	if ix < 0 {
		return 0, 0
	}

	var b, e int
	parseRangeInt(rv[:ix], &b)
	parseRangeInt(rv[ix+1:], &e)
	return b, e
}

func reworkQuery(query string) (string){
	fmt.Printf("old query: %+v\n", query)
	var betweenSlashRE = regexp.MustCompile(`^\s*/(.*)/\s*$`)
	//	Find(All)?(String)?(Submatch)
	var res []string
	res = betweenSlashRE.FindStringSubmatch(query)
	if len(res) == 2 {
		// user wants a regex
		query = res[1]
		fmt.Printf("new query: %+v\n", query)
		return query
	}
	wordsRE := regexp.MustCompile(`[\w\*]+`)
	res = wordsRE.FindAllString(query, -1)

	res2 := mungeWords(res)
	if len(res) > 0 && len(res) < 5  {
		p := prmt.New(prmt.StringSlice(res2))
		query = ""
		var list []string
		for p.Next() {
			list = append(list, strings.Join(res2, ".*"))
		}
		query = strings.Join(list, "|")
	} else {
		query = strings.Join(res2, ".*")
	}
	fmt.Printf("new query: %+v\n", query)
	return query
}

func mungeWords(res []string) ([]string){
	var res2 []string
	for _, x := range res {
		if strings.HasPrefix(x, "*") {
			x = `\w` + x
		}
		if strings.HasSuffix(x, "*") {
			x = strings.TrimSuffix(x, "*")
			x = x + `\w*`
		} else if ! strings.HasSuffix(x, "s") {
			x = x + "s?"
		} else if strings.HasSuffix(x, "s") {
			x = x + "?"
		}
		res2 = append(res2, `\b` + x + `\b`)
	}
	return res2
}

func Setup(m *http.ServeMux, idx map[string]*searcher.Searcher) {

	m.HandleFunc("/api/v1/repos", func(w http.ResponseWriter, r *http.Request) {
		res := map[string]*config.Repo{}
		for name, srch := range idx {
			res[name] = srch.Repo
		}

		writeResp(w, res)
	})

	m.HandleFunc("/api/v1/search", func(w http.ResponseWriter, r *http.Request) {
		var opt index.SearchOptions

		stats := parseAsBool(r.FormValue("stats"))
		repos := parseAsRepoList(r.FormValue("repos"), idx)
		query := r.FormValue("q")
		query = reworkQuery(query)
		opt.Offset, opt.Limit = parseRangeValue(r.FormValue("rng"))
		opt.FileRegexp = r.FormValue("files")
		opt.ExcludeFileRegexp = r.FormValue("excludeFiles")
		opt.IgnoreCase = parseAsBool(r.FormValue("i"))
		opt.OrderResults = parseAsBool(r.FormValue("order"))
		opt.LinesOfContext = parseAsUintValue(
			r.FormValue("ctx"),
			0,
			maxLinesOfContext,
			defaultLinesOfContext)

		var filesOpened int
		var durationMs int

		results, err := searchAll(query, &opt, repos, idx, &filesOpened, &durationMs)
		if err != nil {
			// TODO(knorton): Return ok status because the UI expects it for now.
			writeError(w, err, http.StatusOK)
			return
		}

		var res struct {
			Results map[string]*index.SearchResponse
			Stats   *Stats `json:",omitempty"`
		}

		res.Results = results
		if stats {
			res.Stats = &Stats{
				FilesOpened: filesOpened,
				Duration:    durationMs,
			}
		}

		writeResp(w, &res)
	})

	m.HandleFunc("/api/v1/excludes", func(w http.ResponseWriter, r *http.Request) {
		repo := r.FormValue("repo")
		res := idx[repo].GetExcludedFiles()
		w.Header().Set("Content-Type", "application/json;charset=utf-8")
		w.Header().Set("Access-Control-Allow", "*")
		fmt.Fprint(w, res)
	})

	m.HandleFunc("/api/v1/update", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			writeError(w,
				errors.New(http.StatusText(http.StatusMethodNotAllowed)),
				http.StatusMethodNotAllowed)
			return
		}

		repos := parseAsRepoList(r.FormValue("repos"), idx)

		for _, repo := range repos {
			searcher := idx[repo]
			if searcher == nil {
				writeError(w,
					fmt.Errorf("No such repository: %s", repo),
					http.StatusNotFound)
				return
			}

			if !searcher.Update() {
				writeError(w,
					fmt.Errorf("Push updates are not enabled for repository %s", repo),
					http.StatusForbidden)
				return

			}
		}

		writeResp(w, "ok")
	})

	m.HandleFunc("/api/v1/github-webhook", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			writeError(w,
				errors.New(http.StatusText(http.StatusMethodNotAllowed)),
				http.StatusMethodNotAllowed)
			return
		}

		type Webhook struct {
			Repository struct {
				Name string
				Full_name string
			}
		}

		var h Webhook

		err := json.NewDecoder(r.Body).Decode(&h)

		if err != nil {
		   writeError(w,
				errors.New(http.StatusText(http.StatusBadRequest)),
				http.StatusBadRequest)
			return
		}

		repo := h.Repository.Full_name

		searcher := idx[h.Repository.Full_name]

		if searcher == nil {
			writeError(w,
				fmt.Errorf("No such repository: %s", repo),
				http.StatusNotFound)
			return
		}

		if !searcher.Update() {
			writeError(w,
				fmt.Errorf("Push updates are not enabled for repository %s", repo),
				http.StatusForbidden)
			return
		}

		writeResp(w, "ok")
	})
}
