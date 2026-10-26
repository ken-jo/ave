package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"syscall/js"
	"unicode/utf8"

	"mvdan.cc/sh/v3/expand"
	"mvdan.cc/sh/v3/syntax"
	"mvdan.cc/sh/v3/syntax/typedjson"
)

const sourceBytes = 1_048_576
const syntaxNodes = 200_000
const syntaxDepth = 256
const outputBytes = 67_108_864

var parser = syntax.NewParser(syntax.Variant(syntax.LangBash), syntax.KeepComments(true))

func failure(message string) string {
	result, _ := json.Marshal(map[string]any{"error": message, "totalTokens": 0})
	return string(result)
}

type boundedBuffer struct{ bytes.Buffer }

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > outputBytes {
		return 0, errors.New("Shell syntax output limit exceeded")
	}
	return b.Buffer.Write(p)
}

func parse(_ js.Value, args []js.Value) (result any) {
	fail := failure
	defer func() {
		if recover() != nil {
			result = fail("Shell parser failed")
		}
	}()
	if (len(args) != 1 && len(args) != 2) || args[0].Type() != js.TypeString {
		return fail("Invalid shell parser input")
	}
	tokenLimit := 0
	if len(args) == 2 {
		if args[1].Type() != js.TypeObject {
			return fail("Invalid shell parser limits")
		}
		tokenLimit = args[1].Get("totalTokens").Int()
		if tokenLimit < 0 {
			return fail("Invalid shell parser limits")
		}
	}
	source := args[0].String()
	if len(source) > sourceBytes {
		return fail("Shell analysis source limit exceeded")
	}
	if strings.IndexByte(source, 0) >= 0 {
		return fail("Shell command contains a NUL byte")
	}
	file, err := parser.Parse(strings.NewReader(source), "")
	if err != nil {
		return fail(err.Error())
	}
	count, depth, totalTokens := 0, 0, 0
	literalWords := parser.LiteralHeredocWords()
	excessive := false
	braceWords := [][2]uint{}
	braceWork := syntax.BraceBudget{PartWork: syntaxNodes, LiteralBytes: sourceBytes}
	var annotationError error
	braceInputs := map[*syntax.Word]bool{}
	escapedStrings := map[string]string{}
	syntax.Walk(file, func(node syntax.Node) bool {
		if node == nil {
			depth--
			return true
		}
		count++
		depth++
		switch node := node.(type) {
		case *syntax.Word:
			if node.LiteralData != nil {
				depth--
				return false
			}
			totalTokens++
		case *syntax.DeclClause:
			// Declaration heads are literal command tokens represented as Lit rather than Word.
			totalTokens++
		case *syntax.Assign:
			// A scalar value owns the assignment record; empty and naked assignments still need one.
			if node.Value == nil {
				totalTokens++
			}
		}
		if tokenLimit > 0 && totalTokens > tokenLimit {
			annotationError = errors.New("Shell analysis total token limit exceeded")
		}

		if annotationError != nil {
			depth--
			return false
		}
		if count > syntaxNodes || depth > syntaxDepth {
			excessive = true
			depth--
			return false
		}
		// Brace expansion applies to execution words, not scalar assignment values,
		// test expressions or heredoc data. Commands inside a substitution
		// receive their own CallExpr role even when the containing word is data.
		switch node := node.(type) {
		case *syntax.CallExpr:
			for _, word := range node.Args {
				braceInputs[word] = true
			}
		case *syntax.WordIter:
			for _, word := range node.Items {
				braceInputs[word] = true
			}
		case *syntax.ArrayElem:
			if node.Index == nil && node.Value != nil {
				braceInputs[node.Value] = true
			}
		case *syntax.Assign:
			if node.Naked && node.Value != nil {
				braceInputs[node.Value] = true
			}
		case *syntax.Redirect:
			if node.Op != syntax.Hdoc && node.Op != syntax.DashHdoc && node.Op != syntax.WordHdoc {
				braceInputs[node.Word] = true
			}
		}
		if word, ok := node.(*syntax.Word); ok && braceInputs[word] {
			copy := &syntax.Word{Parts: append([]syntax.WordPart(nil), word.Parts...)}
			split, err := syntax.SplitBracesBounded(copy, &braceWork)
			if err != nil {
				annotationError = err
				depth--
				return false
			}
			if split && containsBrace(copy.Parts) {
				braceWords = append(braceWords, [2]uint{word.Pos().Offset(), word.End().Offset()})
			}
		}
		if quoted, ok := node.(*syntax.SglQuoted); ok && quoted.Dollar {
			cooked, err := expand.Literal(nil, &syntax.Word{Parts: []syntax.WordPart{quoted}})
			if err == nil && utf8.ValidString(cooked) && !strings.ContainsRune(cooked, 0) {
				keyBytes, _ := json.Marshal([2]uint{quoted.Pos().Offset(), quoted.End().Offset()})
				escapedStrings[string(keyBytes)] = cooked
			}
		}
		return true
	})
	if excessive {
		return fail("Shell analysis syntax limit exceeded")
	}
	if annotationError != nil {
		return fail(annotationError.Error())
	}
	literalHeredocs := [][4]uint{}
	if tokenLimit > 0 {
		byteOffset, utf16Offset := uint(0), uint(0)
		for _, word := range literalWords {
			body := *word.LiteralData
			// Only executable gaps are traversed here; data width was recorded by the grammar's terminator reader.
			utf16Offset += utf16Units(source[byteOffset:body[0]])
			literalHeredocs = append(literalHeredocs, [4]uint{body[0], body[1], utf16Offset, utf16Offset + body[2]})
			byteOffset, utf16Offset = body[1], utf16Offset+body[2]
			for _, part := range word.Parts {
				if literal, ok := part.(*syntax.Lit); ok {
					literal.Value = ""
				}
			}
		}
	}
	for _, word := range literalWords {
		word.LiteralData = nil
	}
	var output boundedBuffer
	if err := (typedjson.EncodeOptions{OffsetsOnly: tokenLimit > 0}).Encode(&output, file); err != nil {
		return fail(err.Error())
	}
	resultBytes, err := json.Marshal(struct {
		Tree            json.RawMessage   `json:"tree"`
		TotalTokens     int               `json:"totalTokens"`
		LiteralHeredocs [][4]uint         `json:"literalHeredocs"`
		BraceWords      [][2]uint         `json:"braceWords"`
		EscapedStrings  map[string]string `json:"escapedStrings"`
	}{json.RawMessage(output.Bytes()), totalTokens, literalHeredocs, braceWords, escapedStrings})
	if err != nil {
		return fail(err.Error())
	}
	if len(resultBytes) > outputBytes {
		return fail("Shell syntax output limit exceeded")
	}
	return string(resultBytes)
}

func utf16Units(text string) uint {
	count := uint(0)
	for _, r := range text {
		if r > 0xffff {
			count += 2
		} else {
			count++
		}
	}
	return count
}

func containsBrace(parts []syntax.WordPart) bool {
	for _, part := range parts {
		if _, ok := part.(*syntax.BraceExp); ok {
			return true
		}
	}
	return false
}

func main() {
	callback := js.FuncOf(parse)
	js.Global().Get("_aveShellParserBridge").Call("ready", callback, map[string]any{
		"sourceBytes": sourceBytes, "nodes": syntaxNodes, "depth": syntaxDepth, "outputBytes": outputBytes,
	})
	// The one registered callback owns the runtime lifetime. Per-call trees and
	// serialization buffers remain local and are reclaimed by the runtime.
	select {}
}
